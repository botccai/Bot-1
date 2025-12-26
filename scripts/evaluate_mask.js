#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
(function(){
  try{
    const dir = path.join(process.cwd(),'out','collect_sim');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>path.join(dir,f)) : [];
    if(files.length===0){ console.error('No collect_sim outputs found in',dir); process.exit(1); }
    // choose newest
    files.sort((a,b)=> fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const file = files[0];
    const raw = fs.readFileSync(file,'utf8');
    const obj = JSON.parse(raw);
    const ledgerMask = (obj.ledgerInfo && typeof obj.ledgerInfo.mask === 'number') ? obj.ledgerInfo.mask : 0;
    const ledgerStrong = !!(obj.ledgerInfo && obj.ledgerInfo.strong);
    const sollet = !!obj.solletFlag;
    // dynamic scoring: base = popcount(mask bits)*1 + ledgerStrong*3 + sollet*5
    function popcount(x){ let c=0; while(x){ c+= x & 1; x = x >>> 1; } return c; }
    const maskBits = popcount(ledgerMask);
    const score = (maskBits * 1) + (ledgerStrong ? 3 : 0) + (sollet ? 5 : 0);
    const out = { file, mint: obj.mint, ledgerMask, maskBits, ledgerStrong, sollet, dynamicScore: score, explanation: `score = maskBits*1 + ledgerStrong*3 + sollet*5` };
    console.log(JSON.stringify(out,null,2));
    const outFile = path.join(process.cwd(),'out','collect_sim','mask_eval_'+Date.now()+'.json');
    try{ fs.writeFileSync(outFile, JSON.stringify(out,null,2),'utf8'); console.error('WROTE',outFile); }catch(e){}
    process.exit(0);
  }catch(e){ console.error('eval error', e && e.message || e); process.exit(2); }
})();
