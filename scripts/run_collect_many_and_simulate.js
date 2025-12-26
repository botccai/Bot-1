#!/usr/bin/env node
// Collect N fresh mints and simulate buys (safe), then aggregate ledger/sollet mask stats
const path = require('path');
const fs = require('fs');
(async()=>{
  try{
    const sniper = require(path.join(process.cwd(),'sniper.js'));
    if(!sniper || typeof sniper.collectFreshMints !== 'function'){
      console.error('collectFreshMints not available from sniper.js'); process.exit(2);
    }
    const N = Number(process.env.N_MINTS || process.argv[2] || 50);
    const timeoutMs = Number(process.env.COLLECT_TIMEOUT_MS || Math.max(60000, N * 6000));
    console.error(`Collecting up to ${N} fresh mints (timeout ${timeoutMs}ms)...`);
    const res = await sniper.collectFreshMints({ maxCollect: N, timeoutMs });
    console.error('Collector returned', (Array.isArray(res) ? res.length : 0), 'items');
    const items = Array.isArray(res) ? res : [];
    const results = [];
    // helper popcount
    function popcount(x){ let c=0; while(x){ c += x & 1; x = x >>> 1; } return c; }
    for(const it of items){
      const mint = (it && (it.mint || it.tokenAddress || it.address)) || (typeof it === 'string' ? it : null);
      let ledgerInfo = null;
      try{ const eng = require(path.join(process.cwd(),'sniper.js')).ledgerEngine || null; if(eng && typeof eng.getMaskForMint === 'function'){ const mask = eng.getMaskForMint(mint); const strong = eng.isStrongSignal(mint); ledgerInfo = { mask, strong }; } }catch(e){}
      let solletFlag = false;
      try{ const logs = (it && it.sampleLogs) ? (Array.isArray(it.sampleLogs) ? it.sampleLogs.join('\n').toLowerCase() : String(it.sampleLogs).toLowerCase()) : ''; solletFlag = !!(logs && (logs.includes('initializemint')||logs.includes('initialize mint')||logs.includes('initialize_mint')||logs.includes('createidempotent'))); }catch(e){}
      const mask = (ledgerInfo && typeof ledgerInfo.mask === 'number') ? ledgerInfo.mask : 0;
      const maskBits = popcount(mask);
      const ledgerStrong = !!(ledgerInfo && ledgerInfo.strong);
      const dynamicScore = (maskBits * 1) + (ledgerStrong ? 3 : 0) + (solletFlag ? 5 : 0);
      const simulated = { mint, action: 'buy', status: 'simulated', timestamp: new Date().toISOString() };
      results.push({ collected: it, mint, solletFlag, ledgerInfo, maskBits, dynamicScore, simulated });
    }
    // aggregate stats
    const stats = { total: results.length, solletCount:0, ledgerStrongCount:0, maskBitsHistogram: {}, dynamicScoreHistogram: {}, avgDynamicScore: 0 };
    let sumScore = 0;
    for(const r of results){ if(r.solletFlag) stats.solletCount++; if(r.ledgerInfo && r.ledgerInfo.strong) stats.ledgerStrongCount++; stats.maskBitsHistogram[r.maskBits] = (stats.maskBitsHistogram[r.maskBits]||0)+1; stats.dynamicScoreHistogram[r.dynamicScore] = (stats.dynamicScoreHistogram[r.dynamicScore]||0)+1; sumScore += Number(r.dynamicScore||0); }
    stats.avgDynamicScore = results.length ? (sumScore / results.length) : 0;
    // write output
    const outDir = path.join(process.cwd(),'out','collect_sim'); try{ fs.mkdirSync(outDir, { recursive:true }); }catch(e){}
    const outFile = path.join(outDir, `batch_${Date.now()}.json`);
    const outObj = { time: new Date().toISOString(), params: { N, timeoutMs }, results, stats };
    fs.writeFileSync(outFile, JSON.stringify(outObj, null, 2), 'utf8');
    console.log('WROTE', outFile);
    console.log(JSON.stringify({ total: stats.total, solletCount: stats.solletCount, ledgerStrongCount: stats.ledgerStrongCount, avgDynamicScore: stats.avgDynamicScore }, null, 2));
    process.exit(0);
  }catch(e){ console.error('Runner error', e && e.message || e); process.exit(3); }
})();
