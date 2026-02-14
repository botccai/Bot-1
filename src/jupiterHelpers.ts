import axios, { AxiosRequestConfig } from 'axios'

const JUPITER_BASE = process.env.JUPITER_BASE_URL || 'https://lite-api.jup.ag'
const DEFAULT_TIMEOUT = Number(process.env.JUPITER_HELPER_TIMEOUT_MS) || 8000

type TokenSearchItem = {
  address: string
  symbol?: string
  name?: string
  decimals?: number
  extensions?: Record<string, any>
}

// Simple in-memory cache with TTL
class SimpleCache<V> {
  private map = new Map<string, { v: V; exp: number }>()
  constructor(private ttl = 30_000) {}
  get(key: string) {
    const e = this.map.get(key)
    if (!e) return null
    if (Date.now() > e.exp) {
      this.map.delete(key)
      return null
    }
    return e.v
  }
  set(key: string, value: V) {
    this.map.set(key, { v: value, exp: Date.now() + this.ttl })
  }
  clear() {
    this.map.clear()
  }
}

const tokenSearchCache = new SimpleCache<TokenSearchItem[]>(30_000)

async function withTimeout<T>(p: Promise<T>, ms = DEFAULT_TIMEOUT): Promise<T> {
  let id: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, rej) => {
    id = setTimeout(() => rej(new Error('Timeout')), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (id) clearTimeout(id)
  }
}

async function retryAsync<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1000): Promise<T> {
  let lastErr: any
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

// 1) Search tokens on Jupiter (cached + retry + timeout)
export async function searchTokensOnJupiter(query: string): Promise<TokenSearchItem[]> {
  const cacheKey = `search:${query}`
  const cached = tokenSearchCache.get(cacheKey)
  if (cached) return cached

  const url = `${JUPITER_BASE}/tokens/v2/search?query=${encodeURIComponent(query)}`
  const cfg: AxiosRequestConfig = { method: 'get', url, timeout: DEFAULT_TIMEOUT }

  const data = await retryAsync(async () => {
    const res = await withTimeout(axios.request(cfg), DEFAULT_TIMEOUT)
    if (!res || !res.data) throw new Error('Empty response')
    // expect array of tokens
    const arr: TokenSearchItem[] = Array.isArray(res.data) ? res.data : res.data.tokens || []
    return arr
  }, 3, 800)

  tokenSearchCache.set(cacheKey, data)
  return data
}

// 2) Check that a token exists and return best match
export async function tokenExistsOnJupiter(query: string): Promise<TokenSearchItem | null> {
  const results = await searchTokensOnJupiter(query)
  if (!results || results.length === 0) return null
  // prefer exact address match
  const exact = results.find((t) => t.address === query)
  if (exact) return exact
  // otherwise return top result
  return results[0]
}

// 3) Precheck quote/routes for a token pair using Jupiter quote endpoint
// Note: the exact quote API path/params can vary; make configurable via env if needed
const JUPITER_QUOTE_URL = process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v1/quote'

type QuoteRoute = any

export async function jupiterPrecheckQuote(inputMint: string, outputMint: string, amount: string | number, opts?: { slippageBps?: number; attempts?: number; timeoutMs?: number }) {
  const attempts = opts?.attempts ?? 3
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
  const slippageBps = opts?.slippageBps ?? Number(process.env.JUPITER_SLIPPAGE_BPS) || 100

  const body = {
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: slippageBps,
  }

  return await retryAsync(async () => {
    const res = await withTimeout(axios.post(JUPITER_QUOTE_URL, body, { timeout: timeoutMs }), timeoutMs)
    if (!res || !res.data) throw new Error('Empty quote response')
    const d = res.data
    // Try to detect routes in common shapes
    const routes: QuoteRoute[] = d.routes || d.data || d.route || d.bestRoute ? [d.bestRoute || d.route || d.data || d.routes] : []
    // Some endpoints return array
    if (Array.isArray(d)) return { raw: d, routes: d }
    // Provide parsed minimal shape
    return { raw: d, routes }
  }, attempts, 1000)
}

// Example helper that runs the three-step verification used in the proposals
export async function verifyAndPrecheck(queryOrMint: string, outputMint = 'So11111111111111111111111111111111111111112') {
  const token = await tokenExistsOnJupiter(queryOrMint)
  if (!token) return { ok: false, reason: 'not_found' }

  // precheck route (small amount) to ensure there is an actual route
  try {
    const amount = '1' // 1 unit of input token (interpretation depends on caller)
    const quote = await jupiterPrecheckQuote(token.address, outputMint, amount, { attempts: 3, timeoutMs: 8000 })
    const hasRoutes = (quote && (Array.isArray(quote.routes) ? quote.routes.length > 0 : Boolean(quote.routes)))
    if (!hasRoutes) return { ok: false, reason: 'no_routes', token }
    return { ok: true, token, quote }
  } catch (err: any) {
    return { ok: false, reason: 'quote_error', error: err?.message || String(err), token }
  }
}

export function clearJupiterHelperCache() {
  tokenSearchCache.clear()
}

// Example usage (not executed at import):
// (async () => {
//   const r = await verifyAndPrecheck('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN')
//   console.log('verify result', r)
// })()

export default {
  searchTokensOnJupiter,
  tokenExistsOnJupiter,
  jupiterPrecheckQuote,
  verifyAndPrecheck,
  clearJupiterHelperCache,
}
