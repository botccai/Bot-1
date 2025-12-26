#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
(function(){
  try{
    const dir = path.join(process.cwd(),'out','collect_sim');
    if(!fs.existsSync(dir)){ console.error('No collect_sim directory found at', dir); process.exit(1); }
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>path.join(dir,f));
    if(files.length===0){ console.error('No JSON files found in', dir); process.exit(1); }
    const maskWeight = Number(process.env.MASK_BIT_WEIGHT || process.argv[2] || 1);
    const ledgerWeight = Number(process.env.LEDGER_STRONG_WEIGHT || process.argv[3] || 5);
    const solletWeight = Number(process.env.SOLLET_WEIGHT || process.argv[4] || 3);
    function popcount(x){ let c=0; x = Number(x)||0; while(x){ c += x & 1; x = x >>> 1; } return c; }
    const entries = [];
    for(const file of files){
      try{
        const raw = fs.readFileSync(file,'utf8');
        const obj = JSON.parse(raw);
        // handle batch files
        if(obj && obj.results && Array.isArray(obj.results)){
          for(const r of obj.results){
            const mint = r && (r.mint || (r.collected && r.collected.mint) || (r.collected && r.collected.tokenAddress)) || null;
            const sollet = !!r.solletFlag;
            const ledgerStrong = !!(r.ledgerInfo && r.ledgerInfo.strong);
            const maskBits = (r.ledgerInfo && typeof r.ledgerInfo.mask === 'number') ? popcount(r.ledgerInfo.mask) : (r.maskBits || 0);
            const score = (maskBits * maskWeight) + (ledgerStrong ? ledgerWeight : 0) + (sollet ? solletWeight : 0);
            entries.push({ file: path.basename(file), mint, score, sollet, ledgerStrong, maskBits });
          }
        } else if(obj && (obj.collected || obj.mint)){
          const payload = obj.collected || obj;
          const mint = payload && (payload.mint || payload.tokenAddress || payload.address) || null;
          const sollet = !!obj.solletFlag || !!payload.solletFlag;
          const ledgerMask = (obj.ledgerInfo && typeof obj.ledgerInfo.mask === 'number') ? obj.ledgerInfo.mask : (payload.ledgerInfo && typeof payload.ledgerInfo.mask === 'number' ? payload.ledgerInfo.mask : 0);
          const ledgerStrong = !!(obj.ledgerInfo && obj.ledgerInfo.strong) || !!(payload.ledgerInfo && payload.ledgerInfo.strong);
          const maskBits = popcount(ledgerMask);
          const score = (maskBits * maskWeight) + (ledgerStrong ? ledgerWeight : 0) + (sollet ? solletWeight : 0);
          entries.push({ file: path.basename(file), mint, score, sollet, ledgerStrong, maskBits });
        } else if(Array.isArray(obj)){
          for(const a of obj){ entries.push({ file: path.basename(file), mint: a || null, score: 0, sollet:false, ledgerStrong:false, maskBits:0 }); }
        }
      }catch(e){}
    }
    if(entries.length===0){ console.error('No usable entries found'); process.exit(1); }
    const maxScore = Math.max(...entries.map(e=>Number(e.score||0)));
    const thresholds = [];
    for(let t=0;t<=Math.max(10, Math.ceil(maxScore)+5); t++){ thresholds.push(t); }
    const stats = [];
    for(const thr of thresholds){
      const accepted = entries.filter(e => Number(e.score||0) >= thr);
      const acceptedCount = accepted.length;
      const acceptedSollet = accepted.filter(a=>a.sollet).length;
      const acceptedLedgerStrong = accepted.filter(a=>a.ledgerStrong).length;
      const avgMaskBits = accepted.length ? (accepted.reduce((s,x)=>s + (x.maskBits||0),0) / accepted.length) : 0;
      const precisionSollet = acceptedCount ? (acceptedSollet / acceptedCount) : 0;
      const precisionLedger = acceptedCount ? (acceptedLedgerStrong / acceptedCount) : 0;
      stats.push({ threshold: thr, acceptedCount, acceptedSollet, acceptedLedgerStrong, avgMaskBits, precisionSollet, precisionLedger });
    }
    const out = { generatedAt: new Date().toISOString(), params: { maskWeight, ledgerWeight, solletWeight }, totalEntries: entries.length, thresholds: stats };
    const outDir = path.join(process.cwd(),'out','collect_sim'); try{ fs.mkdirSync(outDir,{ recursive:true }); }catch(e){}
    const outFile = path.join(outDir, `threshold_weighted_${maskWeight}_${ledgerWeight}_${solletWeight}_${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out,null,2),'utf8');
    console.log('WROTE', outFile);
    console.log('Total entries:', entries.length);
    console.log('Sample thresholds:', stats.slice(0,8));
    process.exit(0);
  }catch(e){ console.error('weighted sensitivity error', e && e.message || e); process.exit(2); }
})();
