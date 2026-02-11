import WebSocket from 'ws';

const PRICE_WS_URL = process.env.PRICE_WS_URL || '';
let ws: WebSocket | null = null;
const lastPrices: Map<string, number> = new Map();

export function startWsPriceFeed(){
  if (!PRICE_WS_URL) return;
  if (ws) return;
  try {
    ws = new WebSocket(PRICE_WS_URL);
    ws.on('open', ()=>{ console.log('[priceFeed] connected to', PRICE_WS_URL); });
    ws.on('message', (m)=>{
      try{
        const data = typeof m === 'string' ? JSON.parse(m) : JSON.parse(m.toString());
        // expected format: { mint: string, price: number }
        if (data && data.mint && typeof data.price === 'number'){
          lastPrices.set(String(data.mint), Number(data.price));
        } else if (Array.isArray(data)){
          data.forEach((d:any)=>{ if (d && d.mint && typeof d.price === 'number') lastPrices.set(String(d.mint), Number(d.price)); });
        }
      }catch(e){}
    });
    ws.on('close', ()=>{ console.warn('[priceFeed] websocket closed, will reconnect in 2s'); ws = null; setTimeout(startWsPriceFeed,2000); });
    ws.on('error', (e)=>{ console.error('[priceFeed] ws error', e); try{ ws?.close(); }catch(_e){} ws = null; setTimeout(startWsPriceFeed,2000); });
  } catch (e){ console.error('[priceFeed] failed to start', e); ws = null; }
}

export function stopWsPriceFeed(){ if (ws) { try{ ws.close(); }catch(_e){} ws = null; } }

export function getWsPrice(mint: string): number | null {
  if (!mint) return null;
  const p = lastPrices.get(mint) || lastPrices.get(mint.toUpperCase()) || lastPrices.get(mint.toLowerCase());
  return typeof p === 'number' ? p : null;
}
