#!/usr/bin/env node
/**
 * Lightweight Ledger Signal Engine
 * - short ring buffer (slot window)
 * - ingests minimal events (slot, kind, freshMints, sampleLogs, user, candidateTokens)
 * - produces small bitmask signals per-mint for fast O(1) checks
 */
const DEFAULT_WINDOW_SLOTS = 3;
// bit mapping: place ledger bits outside the existing FSM bit-range to avoid collisions
// FSM uses bits 0..5 (see program_fsm_watcher.js BIT_SLOT_SEQ = 1<<5). Reserve ledger bits starting at 1<<6.
const LEDGER_BIT_BASE_SHIFT = 6;
const BIT_ACCOUNT_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 0); // AccountCreated
const BIT_ATA_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 1);     // ATACreated
const BIT_SAME_AUTH = 1 << (LEDGER_BIT_BASE_SHIFT + 2);       // SameAuthority
const BIT_PROGRAM_INIT = 1 << (LEDGER_BIT_BASE_SHIFT + 3);    // ProgramInit
const BIT_SLOT_DENSE = 1 << (LEDGER_BIT_BASE_SHIFT + 4);      // SlotAligned / density
// New bits per design
const BIT_LP_STRUCT = 1 << (LEDGER_BIT_BASE_SHIFT + 5);      // LP structure (pool/vaults/lp mint)
const BIT_CLEAN_FUNDING = 1 << (LEDGER_BIT_BASE_SHIFT + 6);  // Clean funding pattern (1-2 transfers, same source)
const BIT_SLOT_ALIGNED = 1 << (LEDGER_BIT_BASE_SHIFT + 7);   // Slot-aligned sequence (<=2 slots)
const BIT_CREATOR_EXPOSED = 1 << (LEDGER_BIT_BASE_SHIFT + 8);// Creator funded vault / mint authority exposed
const BIT_SOLLET_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 9); // Sollet-style initialize detected
const metrics = require('./fsm_metrics_logger');

const DBG = !!(process && process.env && (process.env.DEBUG_LEDGER_ENGINE === '1' || process.env.DEBUG_LEDGER_ENGINE === 'true'));

class LedgerSignalEngine {
  constructor(opts = {}){
    this.windowSlots = Number(opts.windowSlots || DEFAULT_WINDOW_SLOTS);
    this.slotBuckets = new Map(); // slot -> { ts, count, mints: Map<mint, flags>, authorities: Map<auth, Set<mint>> }
    this.slotOrder = []; // recent slots in order
    this.densityThreshold = Number(opts.densityThreshold || 3); // events per slot considered dense
    // required number of ledger bits to consider a strong signal (prod default => stronger)
    // Can be overridden via opts or environment variable LEDGER_REQUIRED_BITS
    const envReq = process && process.env && process.env.LEDGER_REQUIRED_BITS ? Number(process.env.LEDGER_REQUIRED_BITS) : null;
    this.requiredBits = (typeof opts.requiredBits === 'number' && opts.requiredBits >= 0) ? Number(opts.requiredBits) : (envReq !== null ? envReq : Number(2));
    // density threshold can be tuned for production via LEDGER_DENSITY_THRESHOLD
    const envDensity = process && process.env && process.env.LEDGER_DENSITY_THRESHOLD ? Number(process.env.LEDGER_DENSITY_THRESHOLD) : null;
    this.densityThreshold = Number(opts.densityThreshold || (envDensity !== null ? envDensity : this.densityThreshold));
    // per-slot transfer records to help funding-pattern heuristics
    // slot -> Array<{ to, from, amount, rawLine }>
    this.slotTransfers = new Map();
  }

  _ensureSlot(slot){
    if(!this.slotBuckets.has(slot)){
      this.slotBuckets.set(slot, { ts: Date.now(), count: 0, mints: new Map(), authorities: new Map() });
      this.slotOrder.push(slot);
      // trim to window
      while(this.slotOrder.length > this.windowSlots){ const rem = this.slotOrder.shift(); this.slotBuckets.delete(rem); }
    }
    return this.slotBuckets.get(slot);
  }

  // ingest an event emitted by sniper / program FSM
  processEvent(ev){
    try{
      const slot = ev && (ev.slot || ev.blockSlot || ev.firstBlock || ev.txBlock || null);
      if(!slot) return; // require explicit slot (managed RPC should provide getSlot())
      const bucket = this._ensureSlot(Number(slot));
      bucket.count = (bucket.count || 0) + 1;
      const fresh = Array.isArray(ev.freshMints) ? ev.freshMints.slice(0,20) : [];
      const auth = ev.user || (ev && ev.signature) || (ev && ev.sourceSignature) || (ev.candidateTokens && ev.candidateTokens[0] && (ev.candidateTokens[0].mintAuthority || ev.candidateTokens[0].authority)) || null;
      const logs = (ev.sampleLogs && Array.isArray(ev.sampleLogs)) ? ev.sampleLogs.join('\n').toLowerCase() : (ev.sampleLogs && typeof ev.sampleLogs === 'string' ? ev.sampleLogs.toLowerCase() : '');
      const kind = ev.kind || (ev && ev.event && ev.event.kind) || '';
      // Parse structured transfer information when available.
      // Prefer instruction objects (parsed) and innerInstructions over raw log text.
      try{
        const arr = this.slotTransfers.get(Number(slot)) || [];
        // 1) Parse `ev.transaction` instructions (top-level message.instructions)
        try{
          const tx = ev && (ev.transaction || ev.tx || ev.parsedTransaction) || null;
          const meta = ev && (ev.meta || ev.transaction && ev.meta) || (ev.meta || null);
          if(tx && tx.message && Array.isArray(tx.message.instructions)){
            for(const ins of tx.message.instructions){
              try{
                // parsed instruction format produced by RPC (ins.parsed.type / ins.parsed.info)
                if(ins && ins.parsed && ins.parsed.type){
                  const t = String(ins.parsed.type).toLowerCase();
                  const info = ins.parsed.info || {};
                  const programId = ins.program || ins.programId || (ins.programId && ins.programId.toString && ins.programId.toString()) || null;
                  // transfers (covers transfer, transferChecked, transferCheckedChecked)
                  if(t.includes('transfer') || t.includes('transferchecked')){
                    const from = info.source || info.from || info.authority || info.owner || null;
                    const to = info.destination || info.to || info.account || info.account || null;
                    const amount = (info.amount !== undefined) ? (Number(info.amount) || null) : (info.uiAmount !== undefined ? Number(info.uiAmount) : null);
                    arr.push({ raw: JSON.stringify(ins), from, to, amount, program: programId, type: t });
                  }
                  // account creation / ATA creation / initialize
                  if(t.includes('create') || t.includes('initialize') || t.includes('createaccount')){
                    arr.push({ raw: JSON.stringify(ins), from: info.source || info.payer || info.authority || null, to: info.account || info.newAccount || info.destination || null, amount: null, program: programId, type: t });
                  }
                  // approve / close / mint operations
                  if(t.includes('approve') || t.includes('close') || t.includes('mint')){
                    const from = info.source || info.from || info.authority || null;
                    const to = info.destination || info.to || info.account || info.account || null;
                    const amount = (info.amount !== undefined) ? (Number(info.amount) || null) : null;
                    arr.push({ raw: JSON.stringify(ins), from, to, amount, program: programId, type: t });
                  }
                } else if(ins && ins.data && ins.program){
                  // fallback: raw instruction with minimal info
                  const raw = JSON.stringify(ins);
                  arr.push({ raw, from: null, to: null, amount: null, program: ins.program, type: 'raw' });
                }
              }catch(_e){}
            }
          }
          // 2) Parse innerInstructions (meta.innerInstructions array) which often contain token transfers
          try{
            const inner = (meta && Array.isArray(meta.innerInstructions)) ? meta.innerInstructions : (meta && meta.innerInstructions) || [];
            for(const block of inner){
              const instrs = (block && block.instructions) || [];
              for(const ins of instrs){
                try{
                  if(ins && ins.parsed && ins.parsed.type){
                    const t = String(ins.parsed.type).toLowerCase();
                    const info = ins.parsed.info || {};
                    if(t.includes('transfer')){
                      const from = info.source || info.from || info.authority || null;
                      const to = info.destination || info.to || info.account || null;
                      const amount = (info.amount !== undefined) ? (Number(info.amount) || null) : (info.uiAmount !== undefined ? Number(info.uiAmount) : null);
                      arr.push({ raw: JSON.stringify(ins), from, to, amount, program: ins.program || ins.programId || null, type: t });
                    }
                    if(t.includes('create') || t.includes('initialize')){
                      arr.push({ raw: JSON.stringify(ins), from: info.source || info.payer || null, to: info.account || info.newAccount || info.destination || null, amount: null, program: ins.program || ins.programId || null, type: t });
                    }
                  }
                }catch(_e){}
              }
            }
          }catch(_e){}
          // 2b) Parse pre/post token balance diffs when available to infer transfers
          try{
            const pre = (meta && Array.isArray(meta.preTokenBalances)) ? meta.preTokenBalances : [];
            const post = (meta && Array.isArray(meta.postTokenBalances)) ? meta.postTokenBalances : [];
            if(pre.length || post.length){
              // build map by accountIndex or by account address
              const map = new Map();
              const acctKeys = (tx && tx.message && Array.isArray(tx.message.accountKeys)) ? tx.message.accountKeys : (tx && tx.message && tx.message.accountKeys) || [];
              for(const p of pre){
                try{
                  const idx = (typeof p.accountIndex !== 'undefined' && p.accountIndex !== null) ? Number(p.accountIndex) : null;
                  const acc = p.account || (idx !== null && acctKeys[idx] ? acctKeys[idx].toString() : null) || null;
                  const owner = p.owner || null;
                  const mint = p.mint || null;
                  const amount = (p.uiTokenAmount && typeof p.uiTokenAmount.amount !== 'undefined') ? Number(p.uiTokenAmount.amount) : (typeof p.uiTokenAmount === 'string' ? Number(p.uiTokenAmount) : (typeof p.amount !== 'undefined' ? Number(p.amount) : null));
                  if(acc){ map.set(acc, { account: acc, owner, mint, pre: amount, post: null }); }
                }catch(_e){}
              }
              for(const q of post){
                try{
                  const idx = (typeof q.accountIndex !== 'undefined' && q.accountIndex !== null) ? Number(q.accountIndex) : null;
                  const acc = q.account || (idx !== null && acctKeys[idx] ? acctKeys[idx].toString() : null) || null;
                  const owner = q.owner || null;
                  const mint = q.mint || null;
                  const amount = (q.uiTokenAmount && typeof q.uiTokenAmount.amount !== 'undefined') ? Number(q.uiTokenAmount.amount) : (typeof q.uiTokenAmount === 'string' ? Number(q.uiTokenAmount) : (typeof q.amount !== 'undefined' ? Number(q.amount) : null));
                  if(acc){
                    const existing = map.get(acc) || { account: acc, owner, mint, pre: null, post: null };
                    existing.post = amount;
                    if(!existing.owner) existing.owner = owner;
                    if(!existing.mint) existing.mint = mint;
                    map.set(acc, existing);
                  }
                }catch(_e){}
              }
              // produce transfer records by looking for increases/decreases
              for(const [acc, rec] of map.entries()){
                try{
                  const preAmt = Number(rec.pre || 0);
                  const postAmt = Number(rec.post || 0);
                  if(postAmt > preAmt){
                    // recipient - try to find likely sender by scanning other entries with decrease
                    let sender = null; let senderAccount = null; let amount = postAmt - preAmt;
                    for(const [acc2, rec2] of map.entries()){
                      if(acc2 === acc) continue;
                      const p2 = Number(rec2.pre || 0); const po2 = Number(rec2.post || 0);
                      if(p2 > po2){ sender = rec2.owner || null; senderAccount = rec2.account; break; }
                    }
                    arr.push({ raw: `balance_diff:${rec.mint || 'unk'}`, from: sender || senderAccount || null, to: rec.owner || rec.account || null, amount, program: 'balance-diff', type: 'balance_diff' });
                  }
                }catch(_e){}
              }
            }
          }catch(_e){}
        }catch(_e){}

        // 3) Fallback to log-line heuristics for any remaining cases (preserve previous behavior)
        if(!arr.length && logs && logs.includes('transfer')){
          const lines = logs.split('\n');
          for(const ln of lines){
            try{
              if(!ln.includes('transfer')) continue;
              const parts = ln.split(/\s+/).filter(Boolean);
              let from = null, to = null, amt = null;
              for(const p of parts){
                if(/^[A-Za-z0-9]{32,44}$/.test(p)){
                  if(!from) from = p; else if(!to) to = p;
                }
                if(/^[0-9]+(\.[0-9]+)?$/.test(p)) amt = Number(p);
              }
              arr.push({ raw: ln, from, to, amount: amt });
            }catch(_e){}
          }
        }

        if(arr.length) this.slotTransfers.set(Number(slot), arr);
        if(DBG && arr && arr.length){
          try{ console.log('[LEDGER_DBG] processEvent slot', Number(slot), 'transfers_count', arr.length, 'sample_transfers', arr.slice(0,6)); }catch(_e){}
        }
      }catch(_e){}

          for(const m of fresh){
          try{
            const key = String(m);
            const entry = bucket.mints.get(key) || { flags: 0, seenSlots: new Set(), sampleLogs: logs };
          // Signal heuristics (minimal parsing, prefer deterministic fields when possible)
          if(kind && String(kind).toLowerCase().includes('initialize')) entry.flags |= BIT_ACCOUNT_CREATED;
          if(logs && (logs.includes('associated') || logs.includes('ata') || logs.includes('associated token'))) entry.flags |= BIT_ATA_CREATED;
          if(logs && (logs.includes('create') || logs.includes('initializemint') || logs.includes('createidempotent'))) entry.flags |= BIT_ACCOUNT_CREATED;
          // honor explicit Sollet-style detection attached to the event
          try{ if(ev && ev.solletCreated) entry.flags |= BIT_SOLLET_CREATED; }catch(_e){}
          if(kind && (String(kind).toLowerCase().includes('pool') || String(kind).toLowerCase().includes('init'))) entry.flags |= BIT_PROGRAM_INIT;
          entry.seenSlots.add(Number(slot));
          bucket.mints.set(key, entry);
          // track authorities
          if(auth){
            const a = String(auth);
            const aset = bucket.authorities.get(a) || new Set();
            aset.add(String(m));
            bucket.authorities.set(a, aset);
          }
        }catch(_e){}
      }
      // Emit per-mint transfer-derived metrics for this slot (help measure CleanFunding/CreatorExposed rates)
      try{
            const transfers = this.slotTransfers.get(Number(slot)) || [];
        for(const m of fresh){
          try{
            const key = String(m);
            const relevant = transfers.filter(t => (t.to === key || t.from === key || (t.raw && String(t.raw).includes(key))));
            const senders = new Set(relevant.filter(r=>r.from).map(r=>r.from));
            const recipients = new Set(relevant.filter(r=>r.to).map(r=>r.to));
            const amountSum = relevant.reduce((s,r)=>{ try{ return s + (Number(r.amount) || 0); }catch(e){ return s; } }, 0);
            // simple clean funding heuristic: <=2 transfers and <=2 unique senders
            const cleanFundingCandidate = (relevant.length > 0) && (relevant.length <= 2) && (senders.size <= 2);
            // creator exposed candidate: any sender matches an authority in the bucket
            let creatorExposedCandidate = false;
            try{
              for(const sAuth of bucket.authorities.keys()){
                if(senders.has(sAuth)) { creatorExposedCandidate = true; break; }
              }
            }catch(_e){}
                // If an ATA was created in this slot and immediately received tokens, mark ATA_CREATED + CLEAN_FUNDING
                try{
                  const hasAtaCreate = transfers.some(t => t.type && String(t.type).toLowerCase().includes('create') && (t.raw && t.raw.toLowerCase().includes('associated')));
                  const ataReceived = relevant.some(r => (r.to && String(r.to).toLowerCase().includes('ata')) || (r.raw && String(r.raw).toLowerCase().includes('associated')));
                  if(hasAtaCreate && ataReceived){
                    // mark in the bucket entry if exists
                    const ent = bucket.mints.get(key);
                    if(ent){ ent.flags |= BIT_ATA_CREATED; ent.flags |= BIT_CLEAN_FUNDING; bucket.mints.set(key, ent); }
                  }
                }catch(_e){}
            const metric = { mint: key, slot: Number(slot), transferCount: relevant.length, uniqueSenders: senders.size, uniqueRecipients: recipients.size, transferAmountSum: amountSum, cleanFundingCandidate: !!cleanFundingCandidate, creatorExposedCandidate: !!creatorExposedCandidate, time: new Date().toISOString() };
            try{ if(metrics && typeof metrics.appendMetric === 'function') metrics.appendMetric(metric); }catch(_e){}
          }catch(_e){}
        }
      }catch(_e){}
      // fast detect slot density
      // nothing else to do here; mask extraction is on-demand
    }catch(e){ /* swallow */ }
  }

  // compute mask for a given mint across the recent window
  getMaskForMint(mint, slot){
    try{
      const key = String(mint);
      let mask = 0;
      // aggregate across window
      for(const s of this.slotOrder){
        const b = this.slotBuckets.get(s);
        if(!b) continue;
        const ent = b.mints.get(key);
        if(ent && ent.flags) mask |= ent.flags;
        // same-authority heuristic: if any authority in this bucket references >1 mint, and includes this mint
        for(const [auth, aset] of b.authorities.entries()){
          if(aset.has(key) && aset.size > 1){ mask |= BIT_SAME_AUTH; break; }
        }
        // density
        if(b.count >= this.densityThreshold) mask |= BIT_SLOT_DENSE;
        // LP-structure heuristic: inspect logs/flags in entry for pool/vault keywords
        try{
          if(ent){
            const sampleLogs = (ent.sampleLogs || '').toLowerCase();
            if(sampleLogs && (sampleLogs.includes('vault') || sampleLogs.includes('pool') || sampleLogs.includes('lp') || sampleLogs.includes('liquidity') || sampleLogs.includes('lp_mint') || sampleLogs.includes('lp mint'))) mask |= BIT_LP_STRUCT;
          }
        }catch(_e){}
        // funding heuristics: look at transfers recorded in this slot that reference this mint
        try{
          const transfers = this.slotTransfers.get(s) || [];
          if(transfers.length>0){
            // count transfers that mention this mint address in raw line or to/from equals mint
            let relevant = transfers.filter(t => (t.to === key || t.from === key || (t.raw && t.raw.includes(key)) || (t.raw && (t.raw.includes('vault') && t.raw.includes(key)) )));
            // if at least 1-2 transfers to same to-address and not from many sources -> clean funding
            if(relevant.length>0){
              // group by to
              const byTo = new Map();
              for(const r of relevant){ const kto = r.to || r.raw || '__unk'; const arr = byTo.get(kto) || []; arr.push(r); byTo.set(kto, arr); }
              for(const [kto, arr] of byTo.entries()){
                const fromSet = new Set(arr.map(x=>x.from||x.raw||'__unk'));
                if(arr.length <= 2 && fromSet.size <= 2){ mask |= BIT_CLEAN_FUNDING; }
                // creator exposed: if any from equals known authority pattern (we'll treat presence of same auth in bucket)
                for(const r of arr){ if(r.from && b.authorities && b.authorities.has(r.from)) mask |= BIT_CREATOR_EXPOSED; }
              }
            }
          }
        }catch(_e){}
      }
      // slot-aligned: check min/max seenSlots across window for this mint
      try{
        let minS = null, maxS = null;
        for(const s of this.slotOrder){ const b = this.slotBuckets.get(s); if(!b) continue; const ent = b.mints.get(key); if(ent && ent.seenSlots && ent.seenSlots.size){ for(const ss of ent.seenSlots){ const n = Number(ss); if(minS===null||n<minS) minS=n; if(maxS===null||n>maxS) maxS=n; } } }
        if(minS!==null && maxS!==null && (maxS - minS) <= 2) mask |= BIT_SLOT_ALIGNED;
      }catch(_e){}
      if(DBG){
        try{
          const perSlot = {};
          for(const s of this.slotOrder){ const arr = this.slotTransfers.get(s) || []; perSlot[s] = arr.filter(t => (t.to === key || t.from === key || (t.raw && String(t.raw).includes(key)))).length; }
          console.log('[LEDGER_DBG] getMaskForMint', key, 'mask', mask, 'perSlotCounts', perSlot, 'slotOrder', this.slotOrder.slice());
        }catch(_e){}
      }
      return mask;
    }catch(e){ return 0; }
  }

  // convenience: boolean strong signal when mask meets bit-count threshold
  isStrongSignal(mint, slot, requiredBits=2){
    const needed = (typeof requiredBits === 'number' && requiredBits>=0) ? requiredBits : this.requiredBits;
    const mask = this.getMaskForMint(mint, slot);
    // count set bits
    let cnt = 0; let m = mask;
    while(m){ cnt += (m & 1); m >>>= 1; }
    return cnt >= needed;
  }
}

module.exports = { LedgerSignalEngine, BIT_ACCOUNT_CREATED, BIT_ATA_CREATED, BIT_SAME_AUTH, BIT_PROGRAM_INIT, BIT_SLOT_DENSE, BIT_LP_STRUCT, BIT_CLEAN_FUNDING, BIT_SLOT_ALIGNED, BIT_CREATOR_EXPOSED, BIT_SOLLET_CREATED };
