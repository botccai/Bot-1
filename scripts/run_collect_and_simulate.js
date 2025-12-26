#!/usr/bin/env node
// Simple runner: collect 1 fresh mint and run a local simulated buy
const path = require('path');
(async()=>{
  try{
    const sn = require(path.join(process.cwd(),'sniper.js'));
    if(!sn || typeof sn.collectFreshMints !== 'function'){
      console.error('collectFreshMints not available from sniper.js'); process.exit(2);
    }
    console.error('Collecting up to 1 fresh mint (60s timeout)...');
    const res = await sn.collectFreshMints({ maxCollect:1, timeoutMs:60000 });
    console.error('Collector returned:', JSON.stringify(res,null,2));
    if(!res || res.length===0){ console.error('No fresh mint collected'); process.exit(0); }
    const mint = (res[0] && (res[0].mint || res[0].tokenAddress || res[0].address)) || (typeof res[0] === 'string' ? res[0] : null);
    const eventData = res[0];
    // attach ledger/sollet signals if available from exported ledgerEngine
    let ledgerInfo = null;
    try{ const eng = require(path.join(process.cwd(),'sniper.js')).ledgerEngine || null; if(eng && typeof eng.getMaskForMint === 'function'){ const mask = eng.getMaskForMint(mint); const strong = eng.isStrongSignal(mint); ledgerInfo = { mask, strong }; } }catch(e){}
    // Simulate buy: no network calls, just a deterministic pretend result
    const simulated = { mint, action: 'buy', status: 'simulated', price: null, slippagePct: null, timestamp: new Date().toISOString() };
    // Attempt to extract sollet flag from eventData.sampleLogs
    let solletFlag = false;
    try{ const logs = (eventData && eventData.sampleLogs) ? (Array.isArray(eventData.sampleLogs) ? eventData.sampleLogs.join('\n').toLowerCase() : String(eventData.sampleLogs).toLowerCase()) : ''; solletFlag = !!(logs && (logs.includes('initializemint')||logs.includes('initialize mint')||logs.includes('initialize_mint')||logs.includes('createidempotent'))); }catch(e){}
    const out = { collected: eventData, mint, solletFlag, ledgerInfo, simulated }; 
    const outDir = path.join(process.cwd(),'out','collect_sim'); try{ require('fs').mkdirSync(outDir,{recursive:true}); }catch(e){}
    const file = path.join(outDir,Date.now()+'.json'); require('fs').writeFileSync(file, JSON.stringify(out,null,2),'utf8');
    console.log('WROTE',file);
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }catch(e){ console.error('Runner error', e && e.message || e); process.exit(3); }
})();
