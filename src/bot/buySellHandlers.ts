import { unifiedBuy, unifiedSell } from '../tradeSources';
import { saveUsers } from './helpers';
import axios from 'axios';
import { getSolBalance } from '../getSolBalance';
import { getGlobalSecretRaw } from '../wallet/globalWallet';
import { upsertTrader, removeTrader, getAllTraders } from '../autoTraderState';
import { startWsPriceFeed, getWsPrice } from '../utils/priceFeedWs';

// In-memory maps for interactive flows and running auto-traders per user
const awaitingAutoToken = new Map<string, boolean>();
const runningAutoTraders = new Map<string, { stop: boolean }>();
// per-trader meta: trade count and last trade timestamp
const tradeMeta = new Map<string, { count: number; lastTs: number }>();

export function registerBuySellHandlers(bot: any, users: Record<string, any>, boughtTokens: Record<string, Set<string>>) {
  bot.action(/buy_(.+)/, async (ctx: any) => {
    const userId = String(ctx.from?.id);
    const user = users[userId];
    const tokenAddress = ctx.match[1];
    const globalSecret = getGlobalSecretRaw();
    const effectiveSecret = user && (user.secret || globalSecret);
    if (!user || !effectiveSecret || !user.strategy || !user.strategy.enabled) {
      await ctx.reply('❌ لا يوجد استراتيجية مفعلة أو محفظة/مفتاح مفقود.');
      return;
    }
    await ctx.reply('⏳ جاري تنفيذ عملية الشراء، يرجى الانتظار...', { parse_mode: 'HTML' });
    try {
      const amount = 0.01;
      // For manual buys initiated via bot UI, prefer returning after broadcast
      // so the user doesn't wait for long confirmation flows. Temporarily
      // enable CONFIRM_ASYNC for the duration of this call.
      const prevConfirm = process.env.CONFIRM_ASYNC;
      try {
        process.env.CONFIRM_ASYNC = 'true';
        const result = await unifiedBuy(tokenAddress, amount, effectiveSecret);
        if (result?.tx) {
          if (!boughtTokens[userId]) boughtTokens[userId] = new Set();
          boughtTokens[userId].add(tokenAddress);
          if (user) {
            const entry = `ManualBuy: ${tokenAddress} | Amount: ${amount} SOL | Source: unifiedBuy | Tx: ${result.tx}`;
            user.history = user.history || [];
            user.history.push(entry);
            saveUsers(users);
          }
          ctx.reply(`✅ تم شراء الرمز بنجاح!\n<a href='https://solscan.io/tx/${result.tx}'>View Tx</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
        } else {
          ctx.reply('❌ فشل الشراء: لم يتم تنفيذ العملية.');
        }
        return;
      } finally {
        if (prevConfirm === undefined) delete process.env.CONFIRM_ASYNC; else process.env.CONFIRM_ASYNC = prevConfirm;
      }
      // (handled above)
    } catch (e: any) {
      ctx.reply(`❌ حدث خطأ أثناء الشراء: ${e?.message || e}`);
    }
  });

  bot.action(/sell_(.+)/, async (ctx: any) => {
    const userId = String(ctx.from?.id);
    const user = users[userId];
    const tokenAddress = ctx.match[1];
    const globalSecretS = getGlobalSecretRaw();
    const effectiveSecretS = user && (user.secret || globalSecretS);
    if (!user || !effectiveSecretS || !user.strategy || !user.strategy.enabled) {
      await ctx.reply('❌ لا يوجد استراتيجية مفعلة أو محفظة/مفتاح مفقود.');
      return;
    }
    await ctx.reply('⏳ جاري تنفيذ عملية البيع، يرجى الانتظار...', { parse_mode: 'HTML' });
    try {
      const amount = 0.01;
      // For manual sells, also prefer async confirmation to avoid long waits in UI.
      const prevConfirm = process.env.CONFIRM_ASYNC;
      try {
        process.env.CONFIRM_ASYNC = 'true';
        const result = await unifiedSell(tokenAddress, amount, effectiveSecretS);
        if (result?.tx) {
          if (boughtTokens[userId]) boughtTokens[userId].delete(tokenAddress);
          if (user) {
            const entry = `Sell: ${tokenAddress} | Amount: ${amount} SOL | Source: unifiedSell | Tx: ${result.tx}`;
            user.history = user.history || [];
            user.history.push(entry);
            saveUsers(users);
          }
          ctx.reply(`✅ تم بيع الرمز بنجاح!\n<a href='https://solscan.io/tx/${result.tx}'>View Tx</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
        } else {
          ctx.reply('❌ فشل البيع: لم يتم تنفيذ العملية.');
        }
        return;
      } finally {
        if (prevConfirm === undefined) delete process.env.CONFIRM_ASYNC; else process.env.CONFIRM_ASYNC = prevConfirm;
      }
    } catch (e: any) {
      ctx.reply(`❌ حدث خطأ أثناء البيع: ${e?.message || e}`);
    }
  });

  // Start Automatic Trading flow (button should trigger action 'auto_trade')
  bot.action('auto_trade', async (ctx: any) => {
    const userId = String(ctx.from?.id);
    const user = users[userId];
    const globalSecretAT = getGlobalSecretRaw();
    if (!user || (!user.secret && !globalSecretAT)) {
      await ctx.reply('❌ الرجاء تفعيل محفظتك أو إعداد السرّ أولاً، أو تهيئة محفظة البوت العامة (BOT_SECRET).');
      return;
    }
    awaitingAutoToken.set(userId, true);
    await ctx.reply('أدخل عنوان المينت (token mint) لتشغيل التداول الآلي، أو أرسل /cancel لإلغاء.');
  });

  // Support auto_trade with token passed in callback data: auto_trade_<mint>
  bot.action(/^auto_trade_(.+)/, async (ctx: any) => {
    const userId = String(ctx.from?.id);
    const user = users[userId];
    const globalSecretAT2 = getGlobalSecretRaw();
    if (!user || (!user.secret && !globalSecretAT2)) {
      await ctx.reply('❌ الرجاء تفعيل محفظتك أو إعداد السرّ أولاً، أو تهيئة محفظة البوت العامة (BOT_SECRET).');
      return;
    }
    const mint = ctx.match && ctx.match[1] ? ctx.match[1] : null;
    if (!mint) { await ctx.reply('❌ لا يمكن استخلاص عنوان المينت من الزر.'); return; }
    await ctx.reply(`✅ تشغيل التداول الآلي ل: ${mint}. أرسل /stop_auto لإيقاف.`);
    if (runningAutoTraders.has(userId)) {
      await ctx.reply('🔒 لديك تداول آلي يعمل بالفعل.');
      return;
    }
    const ctrl = { stop: false };
    runningAutoTraders.set(userId, ctrl);
    // persist initial trader state
    try{ upsertTrader({ userId, mint, in_pos: false, entry: 0, last_sell: 0, createdAt: Date.now() }); }catch(_e){}
    runAutoTrader(user, mint, ctrl, ctx).catch(async (e:any) => {
      console.error('[autoTrader] error for user', userId, e);
      try { await ctx.reply('❌ خطأ أثناء تشغيل التداول الآلي: ' + String(e)); } catch(_){}
    }).finally(()=>{ runningAutoTraders.delete(userId); });
  });

  // Stop automatic trading
  bot.action(/stop_auto/, async (ctx: any) => {
    const userId = String(ctx.from?.id);
    const t = runningAutoTraders.get(userId);
    if (t) {
      t.stop = true;
      await ctx.reply('🛑 تم إيقاف التداول الآلي.');
      // remove persisted state for any traders for this user
      try{
        // remove all persisted traders for this user
        const saved = getAllTraders().filter(s => s.userId === userId);
        for (const s of saved) removeTrader(s.userId, s.mint);
      }catch(_e){}
    } else {
      await ctx.reply('لا يوجد تداول آلي يعمل حالياً لديك.');
    }
  });

  // Listen for text replies to capture mint when awaiting
  bot.on('text', async (ctx: any) => {
    const userId = String(ctx.from?.id);
    if (!awaitingAutoToken.get(userId)) return;
    awaitingAutoToken.delete(userId);
    const user = users[userId];
    const globalSecretText = getGlobalSecretRaw();
    if (!user || (!user.secret && !globalSecretText)) {
      await ctx.reply('❌ لا تملك صلاحية أو محفظة مفعّلة ولا يوجد محفظة بوت عامة.');
      return;
    }
    const mint = (ctx.message && ctx.message.text || '').trim();
    if (!mint) { await ctx.reply('❌ عنوان المينت غير صالح.'); return; }
    await ctx.reply(`✅ تم استلام العنوان: ${mint}. سيتم تشغيل استراتيجية التداول الآلي (محاكاة ما لم يكن LIVE_TRADES=true). أرسل /stop_auto لإيقاف.`);
    // start trader
    if (runningAutoTraders.has(userId)) {
      await ctx.reply('🔒 لديك تداول آلي يعمل بالفعل.');
      return;
    }
    const ctrl = { stop: false };
    runningAutoTraders.set(userId, ctrl);
    try{ upsertTrader({ userId, mint, in_pos: false, entry: 0, last_sell: 0, createdAt: Date.now() }); }catch(_e){}
    runAutoTrader(user, mint, ctrl, ctx).catch(async (e:any) => {
      console.error('[autoTrader] error for user', userId, e);
      try { await ctx.reply('❌ خطأ أثناء تشغيل التداول الآلي: ' + String(e)); } catch(_){}
    }).finally(()=>{ runningAutoTraders.delete(userId); });
  });

  async function runAutoTrader(user: any, mint: string, ctrl: { stop: boolean }, ctx: any) {
    const globalSecretRun = getGlobalSecretRaw();
    const effectiveSecretRun = user && (user.secret || globalSecretRun);
    const timeframes = ['5m','15m','4h','8h'];
    // attempt to load persisted state for this trader
    let in_pos = false;
    let entry = 0 as number;
    let last_sell = 0 as number;
    try{
      const saved = getAllTraders().find(s => s.userId === String(user.id || user.chatId || user.username) && s.mint === mint || s.userId === String(user.id) && s.mint === mint);
      if (saved) {
        in_pos = !!saved.in_pos;
        entry = Number(saved.entry || 0);
        last_sell = Number(saved.last_sell || 0);
      }
    }catch(_e){}
    const minBuySol = Number(process.env.AUTO_MIN_BUY_SOL || 0.0005);
    const pollMs = Number(process.env.AUTO_POLL_MS || 400);

    async function fetch_price(): Promise<number> {
      // prefer websocket price when enabled
      if (String(process.env.USE_WS_PRICE || 'false').toLowerCase() === 'true'){
        const wsP = getWsPrice(mint);
        if (wsP) return wsP;
      }
      const resp = await axios.get(String(process.env.PRICE_FEED_URL || 'https://price.feed/latest'), { timeout: Number(process.env.PRICE_FEED_TIMEOUT_MS || 3000) });
      const v = resp.data && (resp.data.price || resp.data);
      return Number(v || 0);
    }

    function metaKey(uid: string, mint: string){ return `${uid}:${mint}`; }

    function canTrade(uid: string, mint: string){
      const key = metaKey(uid,mint);
      const info = tradeMeta.get(key) || { count: 0, lastTs: 0 };
      const cooldown = Number(process.env.TRADE_COOLDOWN_MS || 30000);
      const maxTrades = Number(process.env.MAX_TRADES_PER_TOKEN || 3);
      if (info.count >= maxTrades) return false;
      if (Date.now() - (info.lastTs || 0) < cooldown) return false;
      return true;
    }

    function recordTrade(uid:string, mint:string){
      const key = metaKey(uid,mint);
      const info = tradeMeta.get(key) || { count: 0, lastTs: 0 };
      info.count = (info.count || 0) + 1;
      info.lastTs = Date.now();
      tradeMeta.set(key, info);
      try{ upsertTrader({ userId: uid, mint, tradeCount: info.count, lastTradeTs: info.lastTs, createdAt: Date.now() }); }catch(_e){}
    }

    async function fetch_indicators(tf: string) {
      const urlBase = String(process.env.INDICATORS_API_BASE || 'https://indicators.api/');
      const resp = await axios.get(urlBase + tf, { timeout: Number(process.env.INDICATORS_API_TIMEOUT_MS || 3000) });
      const v = resp.data;
      return {
        j: Number(v.J || v.j || 0),
        k: Number(v.K || v.k || 0),
        d: Number(v.D || v.d || 0),
        wr6: Number(v.WR6 || v.wr6 || 0),
        wr10: Number(v.WR10 || v.wr10 || 0),
        wr14: Number(v.WR14 || v.wr14 || 0),
      } as any;
    }

    while (!ctrl.stop) {
      try {
        let hits = 0;
        for (const tf of timeframes) {
          try {
            const ind = await fetch_indicators(tf);
            if (ind.j <= 8.0 && ind.k >= 25.0 && ind.k <= 30.0 && ind.d >= 40.0 && ind.wr6 >= 85.0 && ind.wr10 >= 85.0 && ind.wr14 >= 85.0) {
              hits += 1;
            }
          } catch (e) { /* ignore tf error */ }
        }
        const price = await fetch_price();
        if (!in_pos && hits >= 3) {
          // compute buy amount = 10% of SOL balance
          const solBalBefore = await getSolBalance(user.wallet || user.secret || globalSecretRun || '');
          const buyAmt = Math.max(minBuySol, (solBalBefore * 0.10));
          if (buyAmt < minBuySol) {
            await ctx.reply(`⚠️ رصيد SOL غير كافٍ لشراء الحدّ الأدنى (${minBuySol} SOL).`);
          } else {
            const uid = String(user.id || user.chatId || user.username);
            if (!canTrade(uid, mint)) {
              await ctx.reply('⚠️ تجاوزت حدود التداول المؤقتة أو داخل فترة التهدئة.');
            } else {
              await ctx.reply(`⏳ تنفيذ شراء تلقائي بمقدار ${buyAmt} SOL على ${mint} (محاكاة=${process.env.LIVE_TRADES!=='true'})`);
              // final price sanity check before sending
              const priceBeforeSend = await fetch_price().catch(()=>price);
              const maxSlippage = Number(process.env.AUTO_MAX_SLIPPAGE_PERCENT || 3) / 100;
              if (priceBeforeSend && Math.abs(priceBeforeSend - price) / (price || 1) > maxSlippage) {
                await ctx.reply('⚠️ القفز السعري مرتفع جداً — تخطي الشراء لهذه الدورة.');
              } else {
                const solBefore = await getSolBalance(user.wallet || user.secret || globalSecretRun || '').catch(()=>0);
                const res = await unifiedBuy(mint, buyAmt, effectiveSecretRun);
                const solAfter = await getSolBalance(user.wallet || user.secret || globalSecretRun || '').catch(()=>solBefore);
                entry = priceBeforeSend || price;
                in_pos = true;
                recordTrade(uid, mint);
                try{ upsertTrader({ userId: uid, mint, in_pos, entry, last_sell, createdAt: Date.now() }); }catch(_e){}
                await ctx.reply(`✅ تم تنفيذ شراء تلقائي. Tx: ${res && res.tx ? res.tx : 'no-tx'}`);
              }
            }
          }
        }
        if (in_pos) {
          const sellPct = Number(process.env.AUTO_SELL_PROFIT_PERCENT || 1.5) / 100;
          const sellLower = entry * (1 + sellPct);
          const sellUpper = entry * (1 + (sellPct * 2));
          if (price >= sellLower && price <= sellUpper) {
            const uid = String(user.id || user.chatId || user.username);
            const solBefore = await getSolBalance(user.wallet || user.secret || globalSecretRun || '').catch(()=>0);
            await ctx.reply(`⏳ شرط الربح تحقق (${(price/entry-1)*100}%), جاري بيع الكل...`);
            if (!canTrade(uid, mint)) {
              await ctx.reply('⚠️ تجاوزت حدود التداول المؤقتة أو داخل فترة التهدئة — تأجيل البيع.');
            } else {
              const res = await unifiedSell(mint, 'ALL', effectiveSecretRun);
              const solAfter = await getSolBalance(user.wallet || user.secret || globalSecretRun || '').catch(()=>solBefore);
              last_sell = price;
              in_pos = false;
              recordTrade(uid, mint);
              try{ upsertTrader({ userId: uid, mint, in_pos, entry, last_sell, createdAt: Date.now() }); }catch(_e){}
              await ctx.reply(`✅ بيع مكتمل. Tx: ${res && res.tx ? res.tx : 'no-tx'}`);
            }
          } else if (last_sell > 0 && price <= last_sell * (1 - (Number(process.env.REBUY_DROP_PERCENT || 3) / 100))) {
            // rebuy with amount equal to last sold amount (approx by SOL balance diff)
            const solNow = await getSolBalance(user.wallet || user.secret || globalSecretRun || '').catch(()=>0);
            const rebuyAmt = Math.max(minBuySol, solNow * 0.10);
            if (rebuyAmt >= minBuySol) {
              const uid = String(user.id || user.chatId || user.username);
              if (!canTrade(uid, mint)) {
                await ctx.reply('⚠️ تجاوزت حدود التداول المؤقتة أو داخل فترة التهدئة — تأجيل إعادة الشراء.');
              } else {
                await ctx.reply(`⏳ إعادة شراء تلقائي بمقدار ${rebuyAmt} SOL لأن السعر هبط ${Number(process.env.REBUY_DROP_PERCENT||3)}% من آخر بيع.`);
                const priceBeforeSend = await fetch_price().catch(()=>price);
                const maxSlippage = Number(process.env.AUTO_MAX_SLIPPAGE_PERCENT || 3) / 100;
                if (priceBeforeSend && Math.abs(priceBeforeSend - price) / (price || 1) > maxSlippage) {
                  await ctx.reply('⚠️ القفز السعري مرتفع جداً — تخطي إعادة الشراء لهذه الدورة.');
                } else {
                  const res = await unifiedBuy(mint, rebuyAmt, effectiveSecretRun);
                  entry = priceBeforeSend || price;
                  in_pos = true;
                  recordTrade(uid, mint);
                  try{ upsertTrader({ userId: uid, mint, in_pos, entry, last_sell, createdAt: Date.now() }); }catch(_e){}
                  await ctx.reply(`✅ إعادة شراء مكتمل. Tx: ${res && res.tx ? res.tx : 'no-tx'}`);
                }
              }
            }
          }
        }
      } catch (e:any) {
        console.error('[autoTrader] loop error', e);
        try { await ctx.reply('⚠️ خطأ في حلقة التداول الآلي: ' + String(e)); } catch(_){}
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    // cleaning up persisted state on exit
    try{ removeTrader(String(user.id || user.chatId || user.username), mint); }catch(_e){}
  }

  // On startup, resume persisted traders
  try{
    const saved = getAllTraders();
    for (const s of saved) {
      const uid = String(s.userId);
      const user = users[uid];
      if (!user) continue;
      if (runningAutoTraders.has(uid)) continue;
      const ctrl = { stop: false };
      runningAutoTraders.set(uid, ctrl);
      // start trader without ctx (no chat context) — use a minimal stub
      const stubCtx: any = { reply: async (_: any) => {} };
      runAutoTrader(user, s.mint, ctrl, stubCtx).catch((e:any)=>{ console.error('[autoTrader] resume error', uid, s.mint, e); }).finally(()=>{ runningAutoTraders.delete(uid); });
    }
  }catch(_e){}

  // start websocket price feed if requested
  try{ if (String(process.env.USE_WS_PRICE || 'false').toLowerCase() === 'true') startWsPriceFeed(); }catch(_e){}
}
