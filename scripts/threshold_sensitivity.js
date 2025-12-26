#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
(function(){
  try{
    const dir = path.join(process.cwd(),'out','collect_sim');
    if(!fs.existsSync(dir)){ console.error('No collect_sim directory found at', dir); process.exit(1); }
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>path.join(dir,f));
    if(files.length===0){ console.error('No JSON files found in', dir); process.exit(1); }
    const entries = [];
    function popcount(x){ let c=0; x = Number(x)||0; while(x){ c += x & 1; x = x >>> 1; } return c; }
    for(const file of files){
      try{
        const raw = fs.readFileSync(file,'utf8');
        const obj = JSON.parse(raw);
        // detect batch file structure
        if(obj && obj.results && Array.isArray(obj.results)){
          for(const r of obj.results){
            const ts = (r && r.simulated && r.simulated.timestamp) || (obj && obj.time) || new Date().toISOString();
            const score = Number(r.dynamicScore || (r.score) || 0);
            const sollet = !!r.solletFlag;
            const ledgerStrong = !!(r.ledgerInfo && r.ledgerInfo.strong);
            const mask = (r.ledgerInfo && typeof r.ledgerInfo.mask === 'number') ? r.ledgerInfo.mask : 0;
            entries.push({ file: path.basename(file), ts, score, sollet, ledgerStrong, maskBits: popcount(mask) });
          }
        } else if(obj && (obj.mint || obj.collected)){
          // single-collect structure
          const payload = obj.collected || obj;
          const ts = (payload && payload.time) || obj.time || new Date().toISOString();
          const score = Number(obj.dynamicScore || payload.dynamicScore || 0);
          const sollet = !!obj.solletFlag || !!payload.solletFlag;
          const ledgerMask = (obj.ledgerInfo && typeof obj.ledgerInfo.mask === 'number') ? obj.ledgerInfo.mask : (payload.ledgerInfo && typeof payload.ledgerInfo.mask === 'number' ? payload.ledgerInfo.mask : 0);
          const ledgerStrong = !!(obj.ledgerInfo && obj.ledgerInfo.strong) || !!(payload.ledgerInfo && payload.ledgerInfo.strong);
          entries.push({ file: path.basename(file), ts, score, sollet, ledgerStrong, maskBits: popcount(ledgerMask) });
        } else if(obj && Array.isArray(obj)){
          // array of simple strings or tokens
          for(const a of obj){ entries.push({ file: path.basename(file), ts: new Date().toISOString(), score: 0, sollet:false, ledgerStrong:false, maskBits:0 }); }
        }
      }catch(e){ /* skip parse errors */ }
    }
    if(entries.length===0){ console.error('No usable entries found in JSON files'); process.exit(1); }
    // determine threshold range
    const maxScore = Math.max(...entries.map(e=>Number(e.score||0)));
    const maxT = Math.max(1, Math.ceil(maxScore));
    const thresholds = [];
    for(let t=0;t<=maxT+5;t++){ thresholds.push(t); }
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
    const out = { generatedAt: new Date().toISOString(), totalEntries: entries.length, thresholds: stats, sampleEntries: entries.slice(0,50) };
    const outDir = path.join(process.cwd(),'out','collect_sim'); const outFile = path.join(outDir, `threshold_sensitivity_${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out,null,2),'utf8');
    // also write CSV for thresholds
    const csvFile = path.join(outDir, `threshold_sensitivity_${Date.now()}.csv`);
    const header = 'threshold,acceptedCount,acceptedSollet,acceptedLedgerStrong,avgMaskBits,precisionSollet,precisionLedger\n';
    const csvLines = stats.map(s => `${s.threshold},${s.acceptedCount},${s.acceptedSollet},${s.acceptedLedgerStrong},${s.avgMaskBits.toFixed(3)},${s.precisionSollet.toFixed(3)},${s.precisionLedger.toFixed(3)}`).join('\n');
    fs.writeFileSync(csvFile, header + csvLines, 'utf8');
    console.log('WROTE', outFile);
    console.log('WROTE', csvFile);
    console.log('Total entries analyzed:', entries.length);
    console.log('Sample thresholds summary:', stats.slice(0,6));
    process.exit(0);
  }catch(e){ console.error('sensitivity error', e && e.message || e); process.exit(2); }
})();
