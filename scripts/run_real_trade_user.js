#!/usr/bin/env node
// REAL-RUN helper: collects 1 mint, runs live buy then sell for a specified user.
// WARNING: This WILL perform on-chain transactions when LIVE_TRADES=true and user secret is present.
// Run locally only after reviewing and understanding the risks.

const path = require('path');
const fs = require('fs');
(async ()=>{
  try{
    const sniper = require(path.join(process.cwd(),'sniper.js'));
    // try to require the executor; depending on your setup you may need ts-node or a build step
    let autoExecMod = null;
    try{ autoExecMod = require(path.join(process.cwd(),'src','autoStrategyExecutor')); }catch(e){ try{ autoExecMod = require(path.join(process.cwd(),'src','autoStrategyExecutor.js')); }catch(_){}}
    const autoExecuteStrategyForUser = autoExecMod && (autoExecMod.autoExecuteStrategyForUser || autoExecMod.default || null);
    if(!autoExecuteStrategyForUser) throw new Error('autoExecuteStrategyForUser not found - ensure ts files are runnable (use ts-node or prebuild)');

    const USER_ID = process.env.USER_ID || process.env.AUTO_EXEC_CONFIRM_USER_IDS && process.env.AUTO_EXEC_CONFIRM_USER_IDS.split(',')[0] || 'fake-test-user-1';
    const LIVE_TRADES = String(process.env.LIVE_TRADES || 'false').toLowerCase() === 'true';
    if(!LIVE_TRADES) throw new Error('LIVE_TRADES is not true - aborting. Set LIVE_TRADES=true to allow real sends.');
    // Load users
    const usersPath = path.join(process.cwd(),'users.json');
    if(!fs.existsSync(usersPath)) throw new Error('users.json not found in project root');
    const usersRaw = fs.readFileSync(usersPath,'utf8');
    const users = usersRaw ? JSON.parse(usersRaw) : {};
    const user = users[USER_ID] || Object.values(users).find(u=>u && (u.id===USER_ID || u.username===USER_ID));
    if(!user) throw new Error(`User ${USER_ID} not found in users.json`);
    if(!user.secret && !user.wallet) throw new Error('User missing secret/wallet in users.json - cannot proceed with live trades');

    const BUY_AMOUNT = Number(process.env.BUY_AMOUNT || (user.strategy && user.strategy.buyAmount) || 0.008);
    const SELL_DELAY_MS = Number(process.env.SELL_DELAY_MS || 5000);
    const MIN_SOL_RESERVE = Number(process.env.MIN_SOL_RESERVE || 0.001);

    console.log('Collecting 1 fresh mint for live trade...');
    const collected = await sniper.collectFreshMints({ maxCollect:1, timeoutMs:60000 });
    if(!collected || collected.length===0) throw new Error('No fresh mint collected');
    const item = collected[0];
    const mint = item.mint || item.tokenAddress || item.address || (typeof item === 'string' ? item : null);
    if(!mint) throw new Error('Could not determine mint from collector output');

    // attach ledger/sollet signals if available
    const eng = require(path.join(process.cwd(),'sniper.js')).ledgerEngine || null;
    let ledgerInfo = null;
    try{ if(eng){ ledgerInfo = { mask: eng.getMaskForMint(mint), strong: eng.isStrongSignal(mint) }; } }catch(e){}
    const solletFlag = !!(item.solletCreatedHere || item.solletFlag);

    // Safety balance check: require SOL >= BUY_AMOUNT + MIN_SOL_RESERVE
    // Attempt to use getSolBalance util if available
    let solBal = null;
    try{
      const getSolBalMod = require(path.join(process.cwd(),'src','getSolBalance'));
      const getSolBalance = getSolBalMod && (getSolBalMod.default || getSolBalMod.getSolBalance || getSolBalMod);
      if(typeof getSolBalance === 'function'){
        solBal = await getSolBalance(user.wallet || user.secret || '');
      }
    }catch(e){}
    if(solBal !== null){
      console.log('Detected SOL balance for user:', solBal);
      if(Number(solBal) < (BUY_AMOUNT + MIN_SOL_RESERVE)) throw new Error(`Insufficient SOL: have ${solBal}, require ${BUY_AMOUNT + MIN_SOL_RESERVE}`);
    } else {
      console.warn('Could not read SOL balance programmatically; ensure user wallet has at least BUY_AMOUNT + MIN_SOL_RESERVE');
    }

    // Build lightweight token object expected by the executor
    const tokenObj = { address: mint, tokenAddress: mint, mint, ledgerMask: ledgerInfo && ledgerInfo.mask || 0, ledgerStrong: ledgerInfo && ledgerInfo.strong || false, solletCreatedHere: solletFlag, sourceCandidates: true };

    console.log('Running live buy for user', USER_ID, 'on mint', mint, 'buyAmount', BUY_AMOUNT);
    // enforce listenerBypass to avoid additional filtering inside the executor
    const buyResults = await autoExecuteStrategyForUser(user, [Object.assign({}, tokenObj, { strategyBuyAmount: BUY_AMOUNT })], 'buy', { simulateOnly: false, listenerBypass: true });
    console.log('Buy results:', JSON.stringify(buyResults, null, 2));

    // Wait a bit for confirmations / on-chain state to reflect
    console.log('Waiting', SELL_DELAY_MS, 'ms before attempting sell...');
    await new Promise(r=>setTimeout(r, SELL_DELAY_MS));

    console.log('Running live sell for same user/mint');
    const sellResults = await autoExecuteStrategyForUser(user, [tokenObj], 'sell', { simulateOnly: false, listenerBypass: true });
    console.log('Sell results:', JSON.stringify(sellResults, null, 2));

    // Post-run: attempt to compute fees/profit by comparing SOL balance if available
    let solBalAfter = null;
    try{ const getSolBalMod = require(path.join(process.cwd(),'src','getSolBalance')); const getSolBalance = getSolBalMod && (getSolBalMod.default || getSolBalMod.getSolBalance || getSolBalMod); if(typeof getSolBalance === 'function') solBalAfter = await getSolBalance(user.wallet || user.secret || ''); }catch(e){}

    const summary = { time: new Date().toISOString(), user: USER_ID, mint, buyResults, sellResults, solBalBefore: solBal, solBalAfter };
    const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
    const outDir = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(process.cwd(),'out','real_runs');
    // Only write real-run artifacts when archiving explicitly enabled
    if(ENABLE_ARCHIVE){
      try{ fs.mkdirSync(outDir, { recursive:true }); }catch(e){}
      // If running for real, clean previous notification files to start fresh
      try{
        if(String(process.env.RUN_REAL || '').toLowerCase() === '1'){
          const notifDir = path.join(outDir, 'notifications');
          try{ if(fs.existsSync(notifDir)) fs.rmSync(notifDir, { recursive: true, force: true }); }catch(_){ }
          // also remove per-user sent_tokens file to avoid mixing old records
          try{ const sentFile = path.join(process.cwd(),'sent_tokens', `${user && user.id ? user.id : String(user) }.json`); if(fs.existsSync(sentFile)) fs.unlinkSync(sentFile); }catch(_){ }
        }
      }catch(_){ }
      const outFile = path.join(outDir, `real_run_${Date.now()}.json`);
      try{ fs.writeFileSync(outFile, JSON.stringify(summary, null, 2),'utf8'); }catch(_){ }
      console.log('WROTE', outFile);
      console.log('Summary:', JSON.stringify(summary, null, 2));
    } else {
      console.log('ENABLE_ARCHIVE not set: skipping writing real-run files (no archive logs).');
      console.log('Summary (not saved):', JSON.stringify(summary, null, 2));
    }
    process.exit(0);
  }catch(e){ console.error('ERROR:', e && e.message || e); process.exit(2); }
})();
