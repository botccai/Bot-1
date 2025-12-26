#!/usr/bin/env node
// Collect 1 mint, compute weighted dynamic mask, simulate buy+sell for a fake user (no network trades)
const path = require('path');
const fs = require('fs');
(async()=>{
  try{
    const sniper = require(path.join(process.cwd(),'sniper.js'));
    if(!sniper || typeof sniper.collectFreshMints !== 'function'){
      console.error('collectFreshMints not available from sniper.js'); process.exit(2);
    }
    console.error('Collecting 1 fresh mint (60s timeout)...');
    const res = await sniper.collectFreshMints({ maxCollect:1, timeoutMs:60000 });
    if(!res || res.length===0){ console.error('No fresh mint collected'); process.exit(0); }
    const it = res[0];
    const mint = (it && (it.mint || it.tokenAddress || it.address)) || (typeof it === 'string' ? it : null);
    // gather signals
    const solletFlag = !!it.solletCreatedHere || !!it.solletFlag || false;
    let ledgerInfo = null;
    try{ const eng = require(path.join(process.cwd(),'sniper.js')).ledgerEngine || null; if(eng && typeof eng.getMaskForMint === 'function'){ const mask = eng.getMaskForMint(mint); const strong = eng.isStrongSignal(mint); ledgerInfo = { mask, strong }; } }catch(e){}
    const mask = (ledgerInfo && typeof ledgerInfo.mask === 'number') ? ledgerInfo.mask : 0;
    function popcount(x){ let c=0; x = Number(x)||0; while(x){ c += x & 1; x = x >>> 1; } return c; }
    const maskBits = popcount(mask);
    // weights
    const maskWeight = Number(process.env.MASK_BIT_WEIGHT || 1);
    const ledgerWeight = Number(process.env.LEDGER_STRONG_WEIGHT || 5);
    const solletWeight = Number(process.env.SOLLET_WEIGHT || 3);
    const dynamicScore = (maskBits * maskWeight) + ((ledgerInfo && ledgerInfo.strong) ? ledgerWeight : 0) + (solletFlag ? solletWeight : 0);
    // fake user (buy amount configurable via env BUY_AMOUNT)
    const buyAmount = Number(process.env.BUY_AMOUNT || 0.01);
    const fakeUser = { id: 'fake-test-user-1', strategy: { enabled:true, autoBuy:true, buyAmount: buyAmount, maxTrades: Number(process.env.MAX_TRADES || 1) } };
    // simulate buy (no real tx)
    function rand(min, max){ return min + Math.random() * (max - min); }
    const buyPrice = Number((rand(0.01, 0.2)).toFixed(6));
    const buySlippagePct = Number((rand(0.1, 1.5)).toFixed(3));
    const buyResult = { success: true, price: buyPrice, slippagePct: buySlippagePct, spent: fakeUser.strategy.buyAmount, tx: null, simulated: true };
    // simulate immediate sell attempt (for demo) with small random move
    const movePct = rand(-3, 8); // percent change
    const sellPrice = Number((buyPrice * (1 + (movePct/100))).toFixed(6));
    const sellSlippagePct = Number((rand(0.1, 1.5)).toFixed(3));
    const profit = Number(((sellPrice - buyPrice) * (fakeUser.strategy.buyAmount / buyPrice)).toFixed(6));
    const sellResult = { success: true, price: sellPrice, slippagePct: sellSlippagePct, received: fakeUser.strategy.buyAmount + profit, profit, simulated: true };
    const out = { time: new Date().toISOString(), mint, signals: { solletFlag, ledgerInfo, maskBits }, dynamicScore, weights: { maskWeight, ledgerWeight, solletWeight }, fakeUser, buyResult, sellResult };
    const outDir = path.join(process.cwd(),'out','collect_sim'); try{ fs.mkdirSync(outDir,{ recursive:true }); }catch(e){}
    const outFile = path.join(outDir, `live_test_${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out,null,2),'utf8');
    console.log('WROTE', outFile);
    console.log(JSON.stringify(out,null,2));
    process.exit(0);
  }catch(e){ console.error('live test error', e && e.message || e); process.exit(3); }
})();
