#!/usr/bin/env node
// Run real buy+sell using PRIVATE_KEY from environment (LOCAL USE ONLY)
// WARNING: This will send real transactions when LIVE_TRADES=true and a valid PRIVATE_KEY is provided.
// Review code, back up keys, and run only on your machine.

const path = require('path');
const fs = require('fs');
(async ()=>{
  try{
    const sniper = require(path.join(process.cwd(),'sniper.js'));
    let autoExecMod = null;
    try{ autoExecMod = require(path.join(process.cwd(),'src','autoStrategyExecutor')); }catch(e){ try{ autoExecMod = require(path.join(process.cwd(),'src','autoStrategyExecutor.js')); }catch(_){}}
    const autoExecuteStrategyForUser = autoExecMod && (autoExecMod.autoExecuteStrategyForUser || autoExecMod.default || null);
    if(!autoExecuteStrategyForUser) throw new Error('autoExecuteStrategyForUser not found - ensure ts files are runnable (use ts-node or prebuild)');

    const LIVE_TRADES = String(process.env.LIVE_TRADES || 'false').toLowerCase() === 'true';
    if(!LIVE_TRADES) throw new Error('LIVE_TRADES is not true - aborting. Set LIVE_TRADES=true to allow real sends.');

    const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY || '';
    if(!PRIVATE_KEY_RAW) throw new Error('PRIVATE_KEY env is empty. Set PRIVATE_KEY to base64 string or JSON array of bytes.');
    // attempt to normalize to secret usable by loadKeypair in repo
    let secret = PRIVATE_KEY_RAW;
    try{
      const first = PRIVATE_KEY_RAW.trim()[0];
      if(first === '['){ // assume JSON array
        secret = JSON.parse(PRIVATE_KEY_RAW);
      } else if(/^[A-Za-z0-9+/=]+$/.test(PRIVATE_KEY_RAW) && PRIVATE_KEY_RAW.length > 40){
        // likely base64
        secret = PRIVATE_KEY_RAW;
      } else {
        // leave as-is (maybe path or other format)
        secret = PRIVATE_KEY_RAW;
      }
    }catch(e){ secret = PRIVATE_KEY_RAW; }

    const USER_ID = process.env.USER_ID || 'env-user-1';
    // derive wallet pubkey when possible for balance checks
    let userWallet = process.env.BOT_WALLET_ADDRESS || null;
    try{
      const { Keypair } = require('@solana/web3.js');
      let kp = null;
      if(Array.isArray(secret)) kp = Keypair.fromSecretKey(Buffer.from(secret));
      else if(typeof secret === 'string'){
        try{ kp = Keypair.fromSecretKey(Buffer.from(secret, 'base64')); }catch(_){ kp = null; }
      }
      if(kp) userWallet = kp.publicKey.toBase58();
    }catch(e){}

    const user = { id: USER_ID, wallet: userWallet, secret, strategy: { enabled:true, buyAmount: Number(process.env.BUY_AMOUNT || 0.008), sellAmount: Number(process.env.SELL_AMOUNT || process.env.BUY_AMOUNT || 0.008), maxTrades: Number(process.env.MAX_TRADES || 1) } };

    console.log('User summary:', { id: user.id, wallet: user.wallet });

    // collect 1 fresh mint
    console.log('Collecting 1 fresh mint (timeout 60s)...');
    const collected = await sniper.collectFreshMints({ maxCollect:1, timeoutMs:60000 });
    if(!collected || collected.length === 0) throw new Error('No fresh mint collected');
    const item = collected[0];
    const mint = item.mint || item.tokenAddress || item.address || (typeof item === 'string' ? item : null);
    if(!mint) throw new Error('Could not extract mint from collector result');

    // attach ledger/sollet
    const eng = require(path.join(process.cwd(),'sniper.js')).ledgerEngine || null;
    let ledgerInfo = null;
    try{ if(eng){ ledgerInfo = { mask: eng.getMaskForMint(mint), strong: eng.isStrongSignal(mint) }; } }catch(e){}
    const solletFlag = !!(item.solletCreatedHere || item.solletFlag);

    const tokenObj = { address: mint, tokenAddress: mint, mint, ledgerMask: ledgerInfo && ledgerInfo.mask || 0, ledgerStrong: ledgerInfo && ledgerInfo.strong || false, solletCreatedHere: solletFlag, sourceCandidates: true };

    console.log('About to perform LIVE buy for', user.id, 'mint', mint, 'amount', user.strategy.buyAmount);
    console.log('*** FINAL CHECK: Are you running this locally and do you confirm? Set ENV RUN_REAL=1 to proceed ***');
    if(String(process.env.RUN_REAL || '').toLowerCase() !== '1') throw new Error('RUN_REAL not set to 1. Aborting to avoid accidental live trade. Set RUN_REAL=1 to confirm.');

    const beforeBal = (async ()=>{ try{ const getSolBalance = require(path.join(process.cwd(),'src','getSolBalance')); const gb = getSolBalance && (getSolBalance.default || getSolBalance.getSolBalance || getSolBalance); if(typeof gb === 'function') return await gb(user.wallet || user.secret || ''); }catch(e){} return null; })();
    const solBefore = await beforeBal;
    console.log('SOL balance before (if available):', solBefore);

    const buyRes = await autoExecuteStrategyForUser(user, [tokenObj], 'buy', { simulateOnly:false, listenerBypass:true });
    console.log('Buy result:', JSON.stringify(buyRes, null, 2));

    const SELL_DELAY_MS = Number(process.env.SELL_DELAY_MS || 5000);
    console.log('Waiting', SELL_DELAY_MS, 'ms before sell...');
    await new Promise(r=>setTimeout(r, SELL_DELAY_MS));

    const sellRes = await autoExecuteStrategyForUser(user, [tokenObj], 'sell', { simulateOnly:false, listenerBypass:true });
    console.log('Sell result:', JSON.stringify(sellRes, null, 2));

    const afterBal = (async ()=>{ try{ const getSolBalance = require(path.join(process.cwd(),'src','getSolBalance')); const gb = getSolBalance && (getSolBalance.default || getSolBalance.getSolBalance || getSolBalance); if(typeof gb === 'function') return await gb(user.wallet || user.secret || ''); }catch(e){} return null; })();
    const solAfter = await afterBal;

    const summary = { time: new Date().toISOString(), user: user.id, wallet: user.wallet, mint, ledgerInfo, solletFlag, buyRes, sellRes, solBefore, solAfter };
    const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
    const outDir = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(process.cwd(),'out','real_runs');
    // Only write real-run artifacts when archiving explicitly enabled
    if(ENABLE_ARCHIVE){
      try{ fs.mkdirSync(outDir,{ recursive:true }); }catch(e){}
      const outFile = path.join(outDir, `real_env_run_${Date.now()}.json`);
      // If running for real, clean previous notification files to start fresh
      try{
        if(String(process.env.RUN_REAL || '').toLowerCase() === '1'){
          const notifDir = path.join(outDir, 'notifications');
          try{ if(fs.existsSync(notifDir)) fs.rmSync(notifDir, { recursive: true, force: true }); }catch(_){ }
          // also remove per-user sent_tokens file to avoid mixing old records
          try{ const sentFile = path.join(process.cwd(),'sent_tokens', `${USER_ID}.json`); if(fs.existsSync(sentFile)) fs.unlinkSync(sentFile); }catch(_){ }
        }
      }catch(_){ }
      try{ fs.writeFileSync(outFile, JSON.stringify(summary, null, 2),'utf8'); }catch(_){ }
      console.log('WROTE', outFile);
    } else {
      console.log('ENABLE_ARCHIVE not set: skipping writing real-run files (no archive logs).');
    }
    console.log('Summary saved.');
    process.exit(0);
  }catch(e){ console.error('ERROR:', e && e.message || e); process.exit(2); }
})();
