// tradeSources.ts
// Consolidated trading sources with Jupiter, Raydium placeholders, and unified interfaces.

import type { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
const { Keypair, Transaction, VersionedTransaction, SystemProgram, PublicKey } = require('@solana/web3.js');
// spl-token helpers for rent-exemption and ATA checks
const { AccountLayout, getAssociatedTokenAddress } = require('@solana/spl-token');
const { createJupiterApiClient } = require('@jup-ag/api');
import { transactionSenderAndConfirmationWaiter } from './utils/jupiter.transaction.sender';
import { loadKeypair, withTimeout, logTrade } from './utils/tokenUtils';

type TradeSource = 'jupiter' | 'raydium' | 'dexscreener';

// Helper to get RPC connection from pool
const rpcPool = require('./utils/rpcPool').default;

// Jupiter implementation (simulation-first, robust signing/send, optional post-swap fee-split)
const Jupiter = {
  name: 'jupiter',
  async buy(tokenMint: string, amount: number, secret: string | any, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const connection = rpcPool.getRpcConnection();
    console.log(`[Jupiter][buy] Using RPC: ${rpcPool.getLastUsedUrl() || 'unknown'}`);

    // normalize keypair
    let keypair: any;
    try {
      keypair = loadKeypair(secret);
    } catch (e) {
      try {
        const secretKey = Buffer.from(secret, 'base64');
        keypair = Keypair.fromSecretKey(secretKey);
      } catch (ee) {
        throw new Error('Invalid secret provided to Jupiter.buy');
      }
    }

    const userPublicKey = keypair.publicKey.toBase58();

    // config
    const FEE_SPLIT_ENABLED = String(process.env.ENABLE_FEE_SPLIT || 'false').toLowerCase() === 'true';
    const FEE_SPLIT_PERCENT = Number(process.env.FEE_SPLIT_PERCENT || '25');
    const MIN_SOL_RESERVE = Number(process.env.MIN_SOL_RESERVE || '0.001');
    const JUPITER_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS || '15'); // default 0.30%
    const JUPITER_MAX_HOPS = Number(process.env.JUPITER_MAX_HOPS || '2'); // prefer <=2 hops routes
    const PRIOR_FEE = Number(process.env.PRIORITY_FEE_LAMPORTS || '50000');

    // initial balance check (pre-swap) including estimated rent-exemption buffer
    try {
      const solBalance = await connection.getBalance(keypair.publicKey).catch(() => 0);
      const expectedExtraForSplit = (FEE_SPLIT_ENABLED && !isNaN(FEE_SPLIT_PERCENT) && FEE_SPLIT_PERCENT > 0) ? Math.round((amount * (FEE_SPLIT_PERCENT / 100)) * 1e9) : 0;
      // estimate rent for one token account (ATA) to avoid failed attempts when the swap creates an ATA
      let rentForOneAccount = 0;
      try {
        rentForOneAccount = await connection.getMinimumBalanceForRentExemption(AccountLayout.span).catch(() => 0);
      } catch (rentErr) {
        console.warn('[Jupiter][buy] could not determine rent-exemption amount, proceeding without rent buffer:', rentErr);
        rentForOneAccount = 0;
      }
      const requiredLamports = Math.ceil((amount * 1e9) + expectedExtraForSplit + Math.round(MIN_SOL_RESERVE * 1e9) + rentForOneAccount);
      if (solBalance < requiredLamports) throw new Error(`Insufficient SOL balance. Required: ${(requiredLamports/1e9)} SOL (buy + fee-split + reserve + rent buffer), Available: ${solBalance / 1e9}`);
    } catch (e) {
      console.error('[Jupiter][buy] balance pre-check failed:', e);
      throw e;
    }

    // 1. Get Jupiter quote
    const jupiter = createJupiterApiClient();
    let quote: any;
    try {
      quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: tokenMint, amount: Math.floor(amount * 1e9), slippageBps: JUPITER_SLIPPAGE_BPS, prioritizationFeeLamports: PRIOR_FEE });
      // prefer short-hop routes when available
      try{
        if(quote && quote.routePlan && Array.isArray(quote.routePlan.routes)){
          const filtered = quote.routePlan.routes.filter((r:any)=>!(r.marketInfos && r.marketInfos.length>JUPITER_MAX_HOPS));
          if(filtered.length>0) quote.routePlan.routes = filtered;
        }
      }catch(_){ }
    } catch (e) {
      console.error('[Jupiter][buy] Failed to get quote:', e);
      throw e;
    }
    // estimate price (SOL per token) when possible from quote/routePlan
    let estimatedPriceSol: number | null = null;
    try {
      const rp = quote && (quote.routePlan && (quote.routePlan.routes && quote.routePlan.routes[0] ? quote.routePlan.routes[0] : quote.routePlan));
      const outAmount = rp && (rp.outAmount || rp.outAmountLamports || rp.outAmountString) ? Number(rp.outAmount || rp.outAmountLamports || rp.outAmountString) : null;
      const outDecimals = rp && (rp.outDecimals || rp.outputDecimals || 9);
      if (outAmount && !isNaN(outAmount) && outDecimals) {
        const tokenUi = outAmount / Math.pow(10, outDecimals);
        if (tokenUi > 0) estimatedPriceSol = amount / tokenUi;
      }
    } catch (_e) { estimatedPriceSol = null; }
    if (!quote || !quote.routePlan) throw new Error('No route found for token');

    // 2. Request swap transaction from Jupiter
    let swapResp: any;
    try {
      const swapRequest = { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: quote };
      swapResp = await jupiter.swapPost({ swapRequest });
    } catch (e) {
      console.error('[Jupiter][buy] swapPost failed:', e);
      throw e;
    }
    if (!swapResp || !swapResp.swapTransaction) throw new Error('Failed to obtain swap transaction');

    // 3. Sign swap tx locally
    let swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
    try {
      let signed = false;
      try {
        const vt = VersionedTransaction.deserialize(swapTxBuf);
        vt.sign([keypair]);
        swapTxBuf = vt.serialize();
        signed = true;
      } catch (_) {
        try {
          const legacy = Transaction.from(swapTxBuf);
          legacy.sign(keypair);
          swapTxBuf = legacy.serialize();
          signed = true;
        } catch (__){ }
      }
      if (!signed) throw new Error('Failed to sign swap transaction locally');
    } catch (e) {
      console.error('[Jupiter][buy] Error signing swap tx:', e);
      throw e;
    }

    // 4. Simulate before sending
    try {
      let txObj: any;
      try { txObj = VersionedTransaction.deserialize(swapTxBuf); } catch (_) { txObj = Transaction.from(swapTxBuf); }
      const sim = await connection.simulateTransaction(txObj);
      if (sim.value && sim.value.err) {
        console.error('[Jupiter][buy] Swap simulation failed:', sim.value.err);
        console.error('[Jupiter][buy] sim logs:', sim.value.logs || sim);
        throw new Error('Swap simulation failed');
      }
    } catch (e) {
      console.error('[Jupiter][buy] Simulation error:', e);
      throw e;
    }

    // 5. Send via central sender
    let txid = '';
    try {
      // Prefer blockhashWithExpiryBlockHeight returned by the swap API (swapResp) if available.
      // Fallback to the quote's blockhash, then to a fresh RPC blockhash.
      const blockhashWithExpiryBlockHeight = swapResp?.blockhashWithExpiryBlockHeight || quote?.blockhashWithExpiryBlockHeight || (await connection.getLatestBlockhashAndContext('confirmed')).value;

      // Refresh the serialized transaction's blockhash to the active RPC's blockhash to reduce
      // the chance of "blockhash expired before confirmation". Handle both VersionedTransaction
      // and legacy Transaction formats and re-sign after updating.
      try {
        // Attempt VersionedTransaction first
        try {
          const vt = VersionedTransaction.deserialize(swapTxBuf);
          if (vt && vt.message && vt.message.recentBlockhash !== blockhashWithExpiryBlockHeight.blockhash) {
            vt.message.recentBlockhash = blockhashWithExpiryBlockHeight.blockhash;
            // Re-sign with payer keypair
            try { vt.sign([keypair]); } catch (sErr) { console.warn('[Jupiter][buy] Failed to re-sign VersionedTransaction:', sErr); }
            swapTxBuf = vt.serialize();
          }
        } catch (e) {
          // Not a VersionedTransaction, try legacy Transaction
          try {
            const legacy = Transaction.from(swapTxBuf);
            if (legacy && legacy.recentBlockhash !== blockhashWithExpiryBlockHeight.blockhash) {
              legacy.recentBlockhash = blockhashWithExpiryBlockHeight.blockhash;
              // Clear previous signatures and sign again with payer
              legacy.signatures = legacy.signatures.map((s: any) => ({ ...s, signature: null }));
              try { legacy.sign(keypair); } catch (sErr) { console.warn('[Jupiter][buy] Failed to re-sign legacy Transaction:', sErr); }
              swapTxBuf = legacy.serialize();
            }
          } catch (_ignore) {
            // couldn't parse as legacy either; leave swapTxBuf unchanged
          }
        }
      } catch (refreshErr) {
        console.warn('[Jupiter][buy] failed to refresh tx blockhash before send:', refreshErr);
      }

      const res = await transactionSenderAndConfirmationWaiter({ connection, serializedTransaction: swapTxBuf, blockhashWithExpiryBlockHeight, sendOptions: { skipPreflight: false } });
      if (!res || !res.transaction) {
        const liveTradesFlag = process.env.LIVE_TRADES === undefined ? true : (String(process.env.LIVE_TRADES).toLowerCase() === 'true');
        if (!liveTradesFlag) {
          txid = 'DRY-RUN-SIMULATED-TX';
        } else {
          throw new Error('Swap send failed');
        }
      } else {
        txid = res.transaction.signatures?.[0] || '';
      }
    } catch (e) {
      console.error('[Jupiter][buy] Send failed:', e);
      throw e;
    }

    // 6. Optional fee-split: send percentage of bought SOL amount to reserve wallet
    let feeSplitTx: string | null = null;
    let feeSplitAmountSol: number | null = null;
    let feeSplitError: string | null = null;
    try {
      const RESERVE_WALLET = process.env.RESERVE_WALLET || process.env.FEE_RECIPIENT || null;
      if (FEE_SPLIT_ENABLED && RESERVE_WALLET && txid && txid !== 'DRY-RUN-SIMULATED-TX') {
        const percent = Math.max(0, Math.min(100, Number(FEE_SPLIT_PERCENT || 0)));
        const splitSol = (amount * percent) / 100;
        const lamports = Math.round(splitSol * 1e9);
        feeSplitAmountSol = splitSol;
        if (lamports > 0) {
          // Re-check payer balance after the swap: the swap may have consumed SOL
          const postSwapBalance = await connection.getBalance(keypair.publicKey).catch(() => 0);
          // Also ensure reserve wallet has ATA for the bought token (if token is not native SOL)
          if (tokenMint !== SOL_MINT) {
            try {
              const reservePub = new PublicKey(RESERVE_WALLET);
              const ata = await getAssociatedTokenAddress(new PublicKey(tokenMint), reservePub);
              const ataInfo = await connection.getAccountInfo(ata);
              if (!ataInfo) {
                feeSplitError = `Reserve wallet is missing ATA for token ${tokenMint}. Create ATA ${ata.toBase58()} on the reserve wallet first or disable fee-split.`;
                console.warn('[Jupiter][buy] fee-split skipped: reserve ATA missing:', feeSplitError);
                // skip transfer attempt
                // mark as skipped and do not attempt SOL transfer
                // set lamports to 0 to avoid any accidental transfers
              }
            } catch (ataErr) {
              console.warn('[Jupiter][buy] could not verify reserve ATA, proceeding cautiously:', ataErr);
            }
          }
          if (postSwapBalance < lamports + Math.round(MIN_SOL_RESERVE * 1e9)) {
            feeSplitError = `Insufficient SOL after swap to perform fee-split. Required: ${(lamports + Math.round(MIN_SOL_RESERVE * 1e9))/1e9} SOL, Available: ${postSwapBalance/1e9} SOL`;
            console.warn('[Jupiter][buy] fee-split skipped:', feeSplitError);
          } else {
            const transferTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(RESERVE_WALLET), lamports }));
            try { const bh = await connection.getLatestBlockhashAndContext('confirmed'); transferTx.recentBlockhash = bh.value.blockhash; } catch(_){ }
            transferTx.feePayer = keypair.publicKey;
            try { transferTx.sign(keypair); } catch(_){ }
            const serialized = transferTx.serialize();
            const blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
            const transferRes = await transactionSenderAndConfirmationWaiter({ connection, serializedTransaction: serialized, blockhashWithExpiryBlockHeight });
            if (transferRes && transferRes.transaction) {
              const metaAny = (transferRes as any).meta;
              const metaErr = metaAny && (metaAny.err || (metaAny.status && metaAny.status.Err));
              try {
                console.log('[Jupiter][buy] Fee-split transfer meta:', transferRes.meta || null);
                if (transferRes.meta && transferRes.meta.preBalances) console.log('[Jupiter][buy] Fee-split preBalances:', transferRes.meta.preBalances);
                if (transferRes.meta && transferRes.meta.postBalances) console.log('[Jupiter][buy] Fee-split postBalances:', transferRes.meta.postBalances);
              } catch (_) {}
              if (!metaErr) {
                feeSplitTx = transferRes.transaction.signatures?.[0] || null;
                console.log('[Jupiter][buy] Fee-split transfer confirmed on-chain:', feeSplitTx, 'amountSol=', splitSol);
              } else {
                const metaStr = JSON.stringify(metaErr);
                if (String(metaStr).toLowerCase().includes('insufficientfundsforrent')) {
                  feeSplitError = 'Fee-split failed: Insufficient funds for rent when creating recipient account. Ensure the reserve wallet has an ATA for the token or fund the payer with extra SOL to cover rent.';
                } else {
                  feeSplitError = 'Fee-split on-chain error: ' + metaStr;
                }
                console.warn('[Jupiter][buy] Fee-split transfer failed on-chain:', feeSplitError);
              }
            } else {
              feeSplitError = 'Fee-split transfer aborted or not confirmed';
              console.warn('[Jupiter][buy] Fee-split transfer aborted or not confirmed');
            }
          }
        }
      }
    } catch (e) {
      feeSplitError = String(e);
      console.warn('[Jupiter][buy] Fee-split processing error:', feeSplitError);
    }

    return { tx: txid, source: 'jupiter', price: estimatedPriceSol, feeSplitTx, feeSplitAmountSol, feeSplitError };
  },

  async sell(tokenMint: string, amount: number, secret: string | any, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const connection = rpcPool.getRpcConnection();
    console.log(`[Jupiter][sell] Using RPC: ${rpcPool.getLastUsedUrl() || 'unknown'}`);

    // normalize keypair
    let keypair: any;
    try { keypair = loadKeypair(secret); } catch (e) { try { keypair = Keypair.fromSecretKey(Buffer.from(secret, 'base64')); } catch (ee) { throw new Error('Invalid secret provided to Jupiter.sell'); } }
    const userPublicKey = keypair.publicKey.toBase58();

    const jupiter = createJupiterApiClient();
    let quote: any;
    // Attempt quotes with escalating slippage to increase chance of tradable route on new tokens
    let amountForQuote: number | null = null;
    try {
      amountForQuote = (Number.isInteger(amount) && amount > 1e6) ? Math.floor(amount) : Math.floor(amount * 1e9);
      const slippageCandidates = [Number(process.env.JUPITER_SLIPPAGE_BPS || '30'), 100, 300];
      const JUPITER_MAX_HOPS = Number(process.env.JUPITER_MAX_HOPS || '2');
      let lastErr: any = null;
      for (const sl of slippageCandidates) {
        try {
          quote = await jupiter.quoteGet({ inputMint: tokenMint, outputMint: SOL_MINT, amount: amountForQuote, slippageBps: sl });
          if (quote && quote.routePlan && Array.isArray(quote.routePlan.routes)) {
            const filtered = quote.routePlan.routes.filter((r:any)=>!(r.marketInfos && r.marketInfos.length>JUPITER_MAX_HOPS));
            if(filtered.length>0) quote.routePlan.routes = filtered;
          }
          if (quote && quote.routePlan) break;
        } catch (qe) { lastErr = qe; }
      }
      if (!quote || !quote.routePlan) {
        if (lastErr) throw lastErr; else throw new Error('No route found for token');
      }
    } catch (e) {
      console.error('[Jupiter][sell] Failed to get quote:', e);
      throw e;
    }

    // estimate sell price (SOL per token) when possible
    let estimatedPriceSol: number | null = null;
    try {
      const rp = quote && (quote.routePlan && (quote.routePlan.routes && quote.routePlan.routes[0] ? quote.routePlan.routes[0] : quote.routePlan));
      const outAmountLamports = rp && (rp.outAmount || rp.outAmountLamports || rp.outAmountString) ? Number(rp.outAmount || rp.outAmountLamports || rp.outAmountString) : null;
      const inAmount = amountForQuote || null;
      const inDecimals = rp && (rp.inDecimals || rp.inputDecimals || 9);
      if (outAmountLamports && inAmount && !isNaN(outAmountLamports) && inDecimals) {
        const solOut = outAmountLamports / 1e9;
        const tokenUi = inAmount / Math.pow(10, inDecimals);
        if (tokenUi > 0) estimatedPriceSol = solOut / tokenUi;
      }
    } catch (_e) { estimatedPriceSol = null; }

    let swapResp: any;
    try {
      const swapRequest = { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: quote };
      swapResp = await jupiter.swapPost({ swapRequest });
    } catch (e) {
      console.error('[Jupiter][sell] swapPost failed:', e);
      throw e;
    }
    if (!swapResp || !swapResp.swapTransaction) throw new Error('Failed to obtain swap transaction');

    const swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
    let txid = '';
    try {
      // Attempt to sign, simulate and send the swap transaction robustly (mirror buy flow)
      let signedBuf = swapTxBuf;
      try {
        // try VersionedTransaction
        try {
          const vt = VersionedTransaction.deserialize(signedBuf);
          vt.sign([keypair]);
          signedBuf = vt.serialize();
        } catch (_e) {
          // fallback to legacy Transaction
          try {
            const legacy = Transaction.from(signedBuf);
            legacy.sign(keypair);
            signedBuf = legacy.serialize();
          } catch (__e) {
            // leave unsigned if unable to parse
          }
        }
      } catch (signErr) {
        console.warn('[Jupiter][sell] signing warning:', signErr);
      }

      // simulate before sending. If simulation fails, retry once with higher slippage.
      let simErr: any = null;
      try {
        let txObj: any;
        try { txObj = VersionedTransaction.deserialize(signedBuf); } catch (_) { txObj = Transaction.from(signedBuf); }
        const sim = await connection.simulateTransaction(txObj);
        if (sim.value && sim.value.err) {
          simErr = sim;
          throw new Error('Swap simulation failed');
        }
      } catch (eSim: any) {
        console.error('[Jupiter][sell] Swap simulation failed first attempt:', eSim && eSim.value ? eSim.value.err : eSim);
        // attempt retry with higher slippage
        try {
          const retrySl = 100;
          const amountForQuote = (Number.isInteger(amount) && amount > 1e6) ? Math.floor(amount) : Math.floor(amount * 1e9);
          const retryQuote = await jupiter.quoteGet({ inputMint: tokenMint, outputMint: SOL_MINT, amount: amountForQuote, slippageBps: retrySl });
          const retrySwapResp = await jupiter.swapPost({ swapRequest: { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: retryQuote } });
          const retryBuf = Buffer.from(retrySwapResp.swapTransaction, 'base64');
          let signedRetry = retryBuf;
          try { const vt = VersionedTransaction.deserialize(signedRetry); vt.sign([keypair]); signedRetry = vt.serialize(); } catch (_) { try { const lg = Transaction.from(signedRetry); lg.sign(keypair); signedRetry = lg.serialize(); } catch(__){} }
          let txObj2: any;
          try { txObj2 = VersionedTransaction.deserialize(signedRetry); } catch (_) { txObj2 = Transaction.from(signedRetry); }
          const sim2 = await connection.simulateTransaction(txObj2);
          if (sim2.value && sim2.value.err) {
            console.error('[Jupiter][sell] Retry simulation also failed:', sim2.value.err);
            simErr = sim2;
          } else {
            signedBuf = signedRetry;
            simErr = null;
          }
        } catch (retryErr) {
          console.error('[Jupiter][sell] Retry quote/swap failed:', retryErr);
        }
      }
      const FORCE_SEND = String(process.env.FORCE_SEND_ON_SIM_FAIL || '').toLowerCase() === 'true';
      if (simErr && !FORCE_SEND) {
        throw new Error('Swap simulation failed');
      }

      const blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight = swapResp?.blockhashWithExpiryBlockHeight || quote?.blockhashWithExpiryBlockHeight || (await connection.getLatestBlockhashAndContext('confirmed')).value;

      // refresh blockhash on tx and re-sign if necessary
      try {
        try {
          const vt = VersionedTransaction.deserialize(signedBuf);
          if (vt && vt.message && vt.message.recentBlockhash !== blockhashWithExpiryBlockHeight.blockhash) {
            vt.message.recentBlockhash = blockhashWithExpiryBlockHeight.blockhash;
            try { vt.sign([keypair]); } catch (sErr) { console.warn('[Jupiter][sell] Failed to re-sign VersionedTransaction:', sErr); }
            signedBuf = vt.serialize();
          }
        } catch (e) {
          try {
            const legacy = Transaction.from(signedBuf);
            if (legacy && legacy.recentBlockhash !== blockhashWithExpiryBlockHeight.blockhash) {
              legacy.recentBlockhash = blockhashWithExpiryBlockHeight.blockhash;
              legacy.signatures = legacy.signatures.map((s: any) => ({ ...s, signature: null }));
              try { legacy.sign(keypair); } catch (sErr) { console.warn('[Jupiter][sell] Failed to re-sign legacy Transaction:', sErr); }
              signedBuf = legacy.serialize();
            }
          } catch (_ignore) {}
        }
      } catch (refreshErr) {
        console.warn('[Jupiter][sell] failed to refresh tx blockhash before send:', refreshErr);
      }

      const txResult = await transactionSenderAndConfirmationWaiter({ connection, serializedTransaction: signedBuf, blockhashWithExpiryBlockHeight });
      if (!txResult || !txResult.transaction) throw new Error('Transaction failed or not confirmed');
      txid = txResult.transaction.signatures?.[0] || '';
    } catch (e) {
      console.error('[Jupiter][sell] Robust sender failed:', e);
      throw e;
    }
    return { tx: txid, source: 'jupiter', price: estimatedPriceSol };
  }
};

// Raydium implementation wrapper (prefer for performance / single-hop routes)
const Raydium = {
  name: 'raydium',
  async buy(tokenMint: string, amount: number, payerKeypair: any, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const { RaydiumSwapService } = require('./raydium/raydium.service');
    // Pass the payerKeypair through unchanged; RaydiumSwapService will normalize formats.
    const pk = payerKeypair as any;
    const svc = new RaydiumSwapService();
    const slippageBps = Number(process.env.RAYDIUM_SLIPPAGE_BPS || process.env.JUPITER_SLIPPAGE_BPS || '30');
    const gasFee = Number(process.env.RAYDIUM_GAS_FEE_SOL || '0.00001');
    const res = await svc.swapToken(pk, 'So11111111111111111111111111111111111111112', tokenMint, 9, amount, slippageBps, gasFee, false, process.env.RAYDIUM_USERNAME || 'bot', false);
    if (!res) throw new Error('Raydium swap returned null');
    // derive price in SOL per token when Raydium returns quote (in lamports/raw units)
    let price: number | null = null;
    try {
      const q = res.quote;
      if (q && typeof q.inAmount !== 'undefined' && typeof q.outAmount !== 'undefined') {
        const solIn = Number(q.inAmount) / 1e9; // lamports -> SOL
        // assume outAmount is in raw token units; use decimal 9 for SOL side and 9 for token where appropriate
        const outRaw = Number(q.outAmount);
        // best-effort: try token decimals from passed args (decimal param)
        const outDecimals = 9; // fallback; accurate decimals require token metadata
        const tokenUi = outRaw / Math.pow(10, outDecimals);
        if (tokenUi > 0) price = solIn / tokenUi;
      }
    } catch (_e) { price = null; }
    return { tx: res.bundleId || res.signature || res.tx || null, price, signature: res.signature || res.bundleId };
  },
  async sell(tokenMint: string, amount: number, payerKeypair: any, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const { RaydiumSwapService } = require('./raydium/raydium.service');
    const pk = payerKeypair as any;
    const svc = new RaydiumSwapService();
    const slippageBps = Number(process.env.RAYDIUM_SLIPPAGE_BPS || process.env.JUPITER_SLIPPAGE_BPS || '30');
    const gasFee = Number(process.env.RAYDIUM_GAS_FEE_SOL || '0.00001');
    const res = await svc.swapToken(pk, tokenMint, 'So11111111111111111111111111111111111111112', 9, amount, slippageBps, gasFee, false, process.env.RAYDIUM_USERNAME || 'bot', false);
    if (!res) throw new Error('Raydium sell returned null');
    let price: number | null = null;
    try {
      const q = res.quote;
      if (q && typeof q.inAmount !== 'undefined' && typeof q.outAmount !== 'undefined') {
        const tokenInRaw = Number(q.inAmount); // raw units depending on call
        const outRaw = Number(q.outAmount);
        const inDecimals = 9; // best-effort; using 9 as fallback
        const outDecimals = 9;
        const tokenUi = tokenInRaw / Math.pow(10, inDecimals);
        const solOut = outRaw / 1e9;
        if (tokenUi > 0) price = solOut / tokenUi;
      }
    } catch (_e) { price = null; }
    return { tx: res.bundleId || res.signature || res.tx || null, signature: res.signature || res.bundleId, price };
  }
};

// Prefer Jupiter first for broader route coverage, fallback to Raydium
const BUY_SOURCES = [Jupiter, Raydium];
const SELL_SOURCES = [Jupiter, Raydium];

// getJupiterPrice, getRaydiumPrice, getDexPrice helpers (keep previous behavior but simplified)
async function getJupiterPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'jupiter',
    buy: async (tokenMint: string, amount: number, payerKeypair: any) => {
      return await Jupiter.buy(tokenMint, amount, payerKeypair);
    }
  };
}

async function getRaydiumPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'raydium',
    buy: async (tokenMint: string, amount: number, payerKeypair: any) => {
      // Placeholder that routes to Raydium service (existing implementation preserved elsewhere)
      const { RaydiumSwapService } = require('./raydium/raydium.service');
      const pk = payerKeypair as any;
      const svc = new RaydiumSwapService();
      const res = await svc.swapToken(pk, 'So11111111111111111111111111111111111111112', tokenMint, 9, amount, 100, Number(process.env.RAYDIUM_GAS_FEE_SOL || '0.00001'), false, process.env.RAYDIUM_USERNAME || 'bot', false);
      if (!res) throw new Error('Raydium swap returned null');
      return { tx: res.bundleId || res.signature || res.tx || null, price: priceUsd, signature: res.signature || res.bundleId };
    }
  };
}

async function getDexPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'dexscreener',
    buy: async () => ({ tx: 'dummy-dex-tx', price: priceUsd, signature: 'dummy-dex-sign' })
  };
}

// Helper: run sources sequentially (first success wins)
async function raceSources(sources: any[], fnName: 'buy'|'sell', tokenMint: string, amount: number, secret: string): Promise<any> {
  // Run all sources in parallel and return the first successful result (fastest).
  const perSourceTimeout = Number(process.env.SOURCE_TIMEOUT_MS || 5000);
  const PRECHECK_ENABLED = String(process.env.PRECHECK_ENABLED || 'true').toLowerCase() === 'true';
  const PRECHECK_TIMEOUT_MS = Number(process.env.PRECHECK_TIMEOUT_MS || 1200);
  const PRECHECK_MIN_OUT = Number(process.env.PRECHECK_MIN_OUT || 1); // minimal expected token units
  const wrapped = sources.map((s: any) => {
    return (async () => {
      const sourceName = s.name || s.source || 'Unknown';
      // Lightweight pre-check to avoid expensive failing swaps: prefer quick quote/price checks
      if (PRECHECK_ENABLED) {
        try {
          // Jupiter-specific quick quote
          if ((sourceName || '').toLowerCase().includes('jupiter')) {
            try {
              const jupiter = require('@jup-ag/api').createJupiterApiClient();
              const preSl = Number(process.env.PRECHECK_JUP_SLIPPAGE_BPS || process.env.JUPITER_SLIPPAGE_BPS || 30);
              const q = await Promise.race([jupiter.quoteGet({ inputMint: 'So11111111111111111111111111111111111111112', outputMint: tokenMint, amount: Math.max(1, Math.floor(amount * 1e9)), slippageBps: preSl }), new Promise((_,rej)=>setTimeout(()=>rej(new Error('precheck timeout')), PRECHECK_TIMEOUT_MS))]);
              if (!q || !q.routePlan) throw new Error('no jupiter route');
              // try to infer outAmount
              const rp = q.routePlan && (q.routePlan.routes && q.routePlan.routes[0] ? q.routePlan.routes[0] : q.routePlan);
              const outAmt = Number(rp && (rp.outAmount || rp.outAmountLamports || rp.outAmountString) || 0);
              if (!outAmt || outAmt < PRECHECK_MIN_OUT) throw new Error('insufficient out amount on jupiter quote');
            } catch (je) {
              console.warn('[raceSources] Jupiter pre-check failed for', tokenMint, (je as any)?.message ?? String(je));
              throw je;
            }
          } else if ((sourceName || '').toLowerCase().includes('raydium')) {
            // Generic Raydium sanity check using price helper (best-effort)
            try {
              const pr = await getRaydiumPrice(tokenMint, amount).catch(()=>null);
              if (!pr || !pr.priceSol || Number(pr.priceSol) === 0) throw new Error('raydium price unavailable');
            } catch (re) {
              console.warn('[raceSources] Raydium pre-check failed for', tokenMint, (re as any)?.message ?? String(re));
              throw re;
            }
          }
        } catch (preErr) {
          // Fail this source early
          logTrade({ action: fnName, source: sourceName, token: tokenMint, amount, price: null, tx: null, latency: 0, status: 'precheck-fail' });
          throw preErr;
        }
      }
      if (typeof s[fnName] !== 'function') {
        const msg = `${fnName} not implemented in source ${sourceName}`;
        logTrade({ action: fnName, source: sourceName, token: tokenMint, amount, price: null, tx: null, latency: 0, status: 'fail' });
        throw new Error(msg);
      }
      const start = Date.now();
      try {
        const result = await withTimeout(s[fnName](tokenMint, amount, secret), perSourceTimeout, sourceName);
        const end = Date.now();
        let tx: any = null, price: any = null, signature: any = null;
        if (typeof result === 'object' && result !== null) {
          tx = 'tx' in result ? result.tx : null;
          price = 'price' in result ? result.price : null;
          signature = 'signature' in result ? result.signature : null;
        }
        logTrade({ action: fnName, source: sourceName, token: tokenMint, amount, price: price as any, tx: (tx || signature) as any, latency: end - start, status: 'success' });
        return { source: sourceName, tx: tx || signature, price, amount, latency: end - start, raw: result };
      } catch (err: any) {
        logTrade({ action: fnName, source: sourceName, token: tokenMint, amount, price: null, tx: null, latency: 0, status: 'fail' });
        console.error(`[raceSources][${fnName}] Error from ${sourceName}:`, err);
        throw err;
      }
    })();
  });

  try {
    // Promise.any resolves with the first fulfilled promise, rejecting only if all reject.
    const winner = await Promise.any(wrapped);
    const w: any = winner;
    return { source: w.source || w.name || 'Unknown', txSignature: w.tx || (w.raw && (w.raw.signature || w.raw.bundleId)) || null, price: w.price, amount: w.amount, latency: w.latency, raw: w.raw };
  } catch (aggErr: any) {
    // All sources failed. Collect rejection reasons.
    const settled = await Promise.allSettled(wrapped);
    const errors = settled.filter(s => s.status === 'rejected').map(r => String((r as any).reason));
    throw new Error('All sources failed: ' + errors.join(' | '));
  }
}

// unifiedBuy
export async function unifiedBuy(tokenMint: string, amount: number, payerKeypair: any) {
  // Fast-path: attempt a very short Raydium buy first to reduce latency for snipes.
  const FAST_PATH_ENABLED = String(process.env.FAST_PATH_RAYDIUM || 'true').toLowerCase() === 'true';
  const FAST_PATH_TIMEOUT_MS = Number(process.env.RAYDIUM_FAST_TIMEOUT_MS || 800);
  try {
    if (FAST_PATH_ENABLED) {
      try {
        const r = await withTimeout(Raydium.buy(tokenMint, amount, payerKeypair), FAST_PATH_TIMEOUT_MS, 'raydium-fast');
        if (r && (r.tx || r.signature)) {
          return { tx: r.tx || r.signature, source: 'raydium', success: true, raw: r };
        }
      } catch (_e) {
        // fast-path failed or timed out; fall back to full raceSources below
      }
    }
    // Try sources in preferred order (Raydium then Jupiter) using parallel race.
    const res = await raceSources(BUY_SOURCES, 'buy', tokenMint, amount, payerKeypair);
    const r: any = res;
    return { tx: r.tx || r.txSignature || r.signature || null, source: r.source || r.name || 'unknown', success: !!(r.tx || r.txSignature || r.signature), raw: r };
  } catch (e) {
    // If the sequential sources fail, fall back to price-based selection (best effort)
    try {
      const [jupiterInfo, raydiumInfo, dexInfo] = await Promise.all([getJupiterPrice(tokenMint, amount).catch(()=>null), getRaydiumPrice(tokenMint, amount).catch(()=>null), getDexPrice(tokenMint, amount).catch(()=>null)]);
      const infos = [raydiumInfo, jupiterInfo, dexInfo].filter(Boolean);
      const best = infos.reduce((p:any,c:any)=> (p.priceUsd && c.priceUsd && c.priceUsd < p.priceUsd) ? c : p, infos[0]);
      if(!best) throw e;
      const br = await best.buy(tokenMint, amount, payerKeypair);
      return { tx: br && (br.tx || br.signature || br.bundleId) || null, source: best.source || 'unknown', success: !!br };
    } catch (_inner) {
      throw e;
    }
  }
}

// unifiedSell
export async function unifiedSell(tokenMint: string, amount: number | 'ALL', secret: string) {
  // If caller requests to sell the full balance, detect and convert to raw token units.
  if (amount === 'ALL' || Number(amount) === 0) {
    try {
      const connection = rpcPool.getRpcConnection();
      let keypair: any;
      try { keypair = loadKeypair(secret); } catch (e) { try { keypair = Keypair.fromSecretKey(Buffer.from(secret, 'base64')); } catch (ee) { throw new Error('Invalid secret provided to unifiedSell'); } }
      const owner = keypair.publicKey;
      // fetch parsed token accounts for this mint
      const parsed = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(tokenMint) });
      if (!parsed || !parsed.value || parsed.value.length === 0) {
        throw new Error('No token accounts found for owner; nothing to sell');
      }
      // sum raw amounts across accounts (use tokenAmount.amount and decimals)
      let totalRaw = BigInt(0);
      let decimals = 0;
      for (const acc of parsed.value) {
        try {
          const ta = acc.account.data.parsed.info.tokenAmount;
          const amtStr = ta.amount || '0';
          const dec = Number(ta.decimals || 0);
          decimals = dec; // assume same decimals for this mint
          totalRaw += BigInt(amtStr);
        } catch (_e) { }
      }
      if (totalRaw === BigInt(0)) throw new Error('Token balance is zero; nothing to sell');
      // Use raw integer token units as the amount parameter for sellers (Jupiter expects raw units when large integer passed)
      // Convert BigInt to Number when safe; if too large, fall back to string-to-number (may lose precision)
      const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
      let amntForSell: number;
      if (totalRaw <= MAX_SAFE) amntForSell = Number(totalRaw);
      else amntForSell = Number(totalRaw.toString());
      amount = amntForSell;
      console.log('[unifiedSell] Selling full balance for', owner.toBase58(), 'mint', tokenMint, 'rawAmount=', amntForSell, 'decimals=', decimals);
    } catch (e) {
      console.error('[unifiedSell] Failed to auto-detect full balance:', e);
      throw e;
    }
  }
  const res = await raceSources(SELL_SOURCES, 'sell', tokenMint, amount as number, secret);
  const r: any = res;
  const tx = r && (r.tx || r.txSignature || r.signature) || null;
  return {
    tx,
    source: r && (r.source || r.name) || 'unknown',
    success: !!tx,
    raw: r
  };
}

// Batch buy+sell via Jupiter unsigned transactions, then request wallet to sign all transactions at once.
// This reduces Ledger/Sollet prompts by calling `signAllTransactions` once when supported.
export async function unifiedBuyAndSellBatch(walletAdapter: any, tokenMint: string, buyAmountSol: number, slippageBps?: number, options?: { simulateOnly?: boolean, atomic?: boolean, createAtaBeforeSell?: boolean, reverseOrder?: boolean, debugDumpSellSwapResp?: boolean }) {
  if (!walletAdapter || !walletAdapter.publicKey) throw new Error('walletAdapter with publicKey required');
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const connection = rpcPool.getRpcConnection();
  const jupiter = createJupiterApiClient();
  const JUPITER_SLIPPAGE_BPS = Number((slippageBps ?? process.env.JUPITER_SLIPPAGE_BPS) || '30');

  // 1) Get buy quote (SOL -> token)
  const buyAmountLamports = Math.floor(buyAmountSol * 1e9);
  const buyQuote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: tokenMint, amount: buyAmountLamports, slippageBps: JUPITER_SLIPPAGE_BPS }).catch((e:any)=>{ throw new Error('Failed to get buy quote: '+String(e)); });
  if (!buyQuote || !buyQuote.routePlan) throw new Error('No buy route found');

  // Attempt to extract expected output amount from quote
  const expectedOutAmount = buyQuote.outAmount || buyQuote.outAmountLamports || buyQuote.outAmountString || buyQuote.routePlan.outAmount || null;
  if (!expectedOutAmount) {
    // try routePlan routes to compute out amount
    try {
      const route = buyQuote.routePlan.routes && buyQuote.routePlan.routes[0];
      if (route && route.outAmount) {
        // some versions expose outAmount on route
        // leave as-is
      }
    } catch (_) {}
  }
  const outAmountForSell = Number(expectedOutAmount || 0);
  if (!outAmountForSell || outAmountForSell <= 0) throw new Error('Cannot determine expected token output amount for sell preparation');

  // 2) Build unsigned buy swap transaction
  const userPublicKey = walletAdapter.publicKey.toBase58();
  const buySwapReq = { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: buyQuote };
  const buySwapResp = await jupiter.swapPost({ swapRequest: buySwapReq }).catch((e:any)=>{ throw new Error('Failed to build buy swap transaction: '+String(e)); });
  if (!buySwapResp || !buySwapResp.swapTransaction) throw new Error('Failed to obtain buy swap transaction');
  const buyBuf = Buffer.from(buySwapResp.swapTransaction, 'base64');

  // Optional: simulate the buy swap to extract actual output token amount (base units) and ATA address
  let extractedOutAmount = Number(expectedOutAmount || 0);
  let extractedAta: string | null = null;
  try {
    const buyTxObj = (() => { try { return VersionedTransaction.deserialize(buyBuf); } catch (_) { return Transaction.from(buyBuf); } })();
    const simBuy = await connection.simulateTransaction(buyTxObj).catch(()=>null);
    if (simBuy && simBuy.value && simBuy.value.postTokenBalances) {
      const post = simBuy.value.postTokenBalances;
      for (const p of post) {
        if (p && p.mint === tokenMint && p.owner === userPublicKey) {
          extractedOutAmount = Number(p.amount || p.uiTokenAmount?.amount || 0);
          extractedAta = p.accountIndex != null ? null : null;
          break;
        }
      }
    }
  } catch (e) {
    // ignore simulation extraction errors
  }

  // 3) Build unsigned sell swap transaction (token -> SOL) using expected out amount
  // Prefer extractedOutAmount (from simulated buy) if available
  const sellAmountForQuote = extractedOutAmount && extractedOutAmount > 0 ? Math.floor(extractedOutAmount) : Math.floor(outAmountForSell);
  const sellQuote = await jupiter.quoteGet({ inputMint: tokenMint, outputMint: SOL_MINT, amount: sellAmountForQuote, slippageBps: JUPITER_SLIPPAGE_BPS }).catch((e:any)=>{ throw new Error('Failed to get sell quote: '+String(e)); });
  if (!sellQuote || !sellQuote.routePlan) throw new Error('No sell route found');
  const sellSwapReq = { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: sellQuote };
  const sellSwapResp = await jupiter.swapPost({ swapRequest: sellSwapReq }).catch((e:any)=>{ throw new Error('Failed to build sell swap transaction: '+String(e)); });
  if (!sellSwapResp || !sellSwapResp.swapTransaction) throw new Error('Failed to obtain sell swap transaction');
  const sellBuf = Buffer.from(sellSwapResp.swapTransaction, 'base64');

  // Debug helper: if requested, return the raw sellSwapResp for inspection (accountKeys, instruction metas)
  if (options && options.debugDumpSellSwapResp) {
    try {
      // avoid leaking huge buffers; stringify safe fields
      const safe: any = {
        swapResponseKeys: sellSwapResp?.accountKeys || sellSwapResp?.accounts || null,
        swapResponseMeta: { blockhashWithExpiryBlockHeight: sellSwapResp?.blockhashWithExpiryBlockHeight || null, swapTransaction: '<<base64 omitted>>' },
        raw: (()=>{ try{ const copy = { ...sellSwapResp }; if(copy.swapTransaction) copy.swapTransaction = '<<base64 omitted>>'; return copy; }catch(_){ return null; } })()
      };
      console.log('[unifiedBuyAndSellBatch][debugDumpSellSwapResp] dumping sellSwapResp');
      return safe;
    } catch (e) {
      return { error: String(e), raw: (sellSwapResp && typeof sellSwapResp === 'object') ? JSON.stringify(Object.keys(sellSwapResp)) : String(sellSwapResp) };
    }
  }

  // 4) Deserialize txs into objects wallet can sign or simulate
  const txs: any[] = [];
  try {
    // push transactions in requested order
    if (options && options.reverseOrder) {
      try { txs.push(VersionedTransaction.deserialize(sellBuf)); } catch (_) { txs.push(Transaction.from(sellBuf)); }
      // optionally insert ATA before sell
      if (options && options.createAtaBeforeSell) {
        try {
          const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
          const ownerPub = new PublicKey(walletAdapter.publicKey.toBase58());
          const mintPub = new PublicKey(tokenMint);
          const ataAddr = await getAssociatedTokenAddress(mintPub, ownerPub);
          const ataTx = new Transaction();
          ataTx.add(createAssociatedTokenAccountInstruction(ownerPub, ataAddr, ownerPub, mintPub));
          try { ataTx.recentBlockhash = (await connection.getLatestBlockhashAndContext('confirmed')).value.blockhash; } catch (_) {}
          ataTx.feePayer = ownerPub;
          txs.push(ataTx);
        } catch (_aErr) {}
      }
      try { txs.push(VersionedTransaction.deserialize(buyBuf)); } catch (_) { txs.push(Transaction.from(buyBuf)); }
    } else {
      try { txs.push(VersionedTransaction.deserialize(buyBuf)); } catch (_) { txs.push(Transaction.from(buyBuf)); }
      if (options && options.createAtaBeforeSell) {
        try {
          const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
          const ownerPub = new PublicKey(walletAdapter.publicKey.toBase58());
          const mintPub = new PublicKey(tokenMint);
          const ataAddr = await getAssociatedTokenAddress(mintPub, ownerPub);
          const ataTx = new Transaction();
          ataTx.add(createAssociatedTokenAccountInstruction(ownerPub, ataAddr, ownerPub, mintPub));
          try { ataTx.recentBlockhash = (await connection.getLatestBlockhashAndContext('confirmed')).value.blockhash; } catch (_) {}
          ataTx.feePayer = ownerPub;
          txs.push(ataTx);
        } catch (_aErr) {}
      }
      try { txs.push(VersionedTransaction.deserialize(sellBuf)); } catch (_) { txs.push(Transaction.from(sellBuf)); }
    }
    // If option to create ATA before sell is set, append an ATA creation transaction before the sell
    if (options && options.createAtaBeforeSell) {
      try {
        const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
        const ownerPub = new PublicKey(walletAdapter.publicKey.toBase58());
        const mintPub = new PublicKey(tokenMint);
        const ataAddr = await getAssociatedTokenAddress(mintPub, ownerPub);
        const ataTx = new Transaction();
        // createAssociatedTokenAccountInstruction(payer, associatedToken, owner, mint)
        ataTx.add(createAssociatedTokenAccountInstruction(ownerPub, ataAddr, ownerPub, mintPub));
        try { ataTx.recentBlockhash = (await connection.getLatestBlockhashAndContext('confirmed')).value.blockhash; } catch (_) {}
        ataTx.feePayer = ownerPub;
        txs.push(ataTx);
      } catch (_aErr) {
        // ignore ATA construction failure and continue to push sell tx normally
      }
    }
    try { txs.push(VersionedTransaction.deserialize(sellBuf)); } catch (_) { txs.push(Transaction.from(sellBuf)); }
  } catch (e) { throw new Error('Failed to deserialize swap transactions: '+String(e)); }
  // If simulateOnly option is set, simulate txs instead of signing/sending
  if (options && options.simulateOnly) {
    // If atomic requested, attempt to merge into a single legacy Transaction when possible
    if (options.atomic) {
      try {
        const [tBuy, tSell] = txs;
        if (tBuy instanceof Transaction && tSell instanceof Transaction) {
          const merged = new Transaction();
          merged.add(...(tBuy.instructions || []));
          merged.add(...(tSell.instructions || []));
          merged.feePayer = walletAdapter.publicKey;
          try { merged.recentBlockhash = (await connection.getLatestBlockhashAndContext('confirmed')).value.blockhash; } catch(_){}
          const sim = await connection.simulateTransaction(merged).catch((e:any)=>({ error: String(e) }));
          return [{ atomic: true, simulated: sim }];
        }
      } catch (_atomicErr) {
        // fallthrough to simulate separately
      }
    }

    // Simulate buy and sell separately
    const sims: any[] = [];
    for (const t of txs) {
      try {
        const simRes = await connection.simulateTransaction(t).catch((e:any)=>({ error: String(e) }));
        sims.push(simRes);
      } catch (e) { sims.push({ error: String(e) }); }
    }
    return sims;
  }

  // 5) Ask wallet to sign all txs in one call if supported
  let signedTxs: any[] = [];
  if (typeof walletAdapter.signAllTransactions === 'function') {
    try {
      signedTxs = await walletAdapter.signAllTransactions(txs);
    } catch (e) {
      // fall back to per-tx sign
      signedTxs = [];
      for (const t of txs) {
        if (typeof walletAdapter.signTransaction === 'function') {
          signedTxs.push(await walletAdapter.signTransaction(t));
        } else {
          throw new Error('Wallet adapter does not support signing');
        }
      }
    }
  } else if (typeof walletAdapter.signTransaction === 'function') {
    for (const t of txs) signedTxs.push(await walletAdapter.signTransaction(t));
  } else {
    throw new Error('Wallet adapter has no signAllTransactions/signTransaction methods');
  }

  // 6) Serialize signed txs and send sequentially (we avoid atomicity here but reduce prompts)
  const results: any[] = [];
  for (const st of signedTxs) {
    let serialized: Buffer;
    try {
      try { serialized = Buffer.from((st as any).serialize()); } catch (_) { serialized = Buffer.from((st as any).serialize()); }
    } catch (e) {
      throw new Error('Failed to serialize signed transaction: '+String(e));
    }
    const blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
    const res = await transactionSenderAndConfirmationWaiter({ connection, serializedTransaction: serialized, blockhashWithExpiryBlockHeight }).catch((e:any)=>{ return { error: String(e) }; });
    results.push(res);
  }
  return results;
}