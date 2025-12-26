#!/usr/bin/env node
// Process sent_tokens entries and run hooks for successful live transactions only
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

(async function(){
  try{
    const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
    const SENT_DIR = path.join(process.cwd(),'sent_tokens');
    if(!fs.existsSync(SENT_DIR)){
      console.log('No sent_tokens directory found. Nothing to process.');
      process.exit(0);
    }
    const files = fs.readdirSync(SENT_DIR).filter(f=>f.endsWith('.json'));
    if(files.length===0){ console.log('No user files in sent_tokens to process.'); process.exit(0); }

    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const DEFAULT_CHAT = process.env.TELEGRAM_USER_ID || process.env.TELEGRAM_DEFAULT_CHAT || '';

    let totalProcessed = 0;
    for(const f of files){
      const p = path.join(SENT_DIR, f);
      let arr = [];
      try{ arr = JSON.parse(fs.readFileSync(p, 'utf8') || '[]'); }catch(e){ console.error('Failed to read',p); continue; }
      let modified = false;
      for(const entry of arr){
        try{
          // Only handle successful on-chain transactions (buy/sell) and not yet processed
          if(!entry || entry.status !== 'success') continue;
          if(!entry.mode || (entry.mode !== 'buy' && entry.mode !== 'sell')) continue;
          if(entry.hookProcessed) continue;
          // Prefer per-entry chat id if available, else default
          const chatId = entry.chatId || entry.userId || DEFAULT_CHAT;
          const msgLines = [];
          msgLines.push(`✅ Live ${entry.mode.toUpperCase()} executed`);
          if(entry.token) msgLines.push(`Token: ${entry.token}`);
          if(typeof entry.amount !== 'undefined') msgLines.push(`Amount: ${entry.amount}`);
          if(entry.tx) msgLines.push(`Tx: ${entry.tx}`);
          if(entry.summary) msgLines.push(`${entry.summary}`);
          const text = msgLines.join('\n');
          // Send Telegram notification if token exists
          if(TELEGRAM_BOT_TOKEN && chatId){
            try{
              const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
              await axios.post(url, { chat_id: String(chatId), text, parse_mode: 'HTML' }, { timeout: 10000 });
              console.log('Notified via Telegram for', f, 'entry id:', entry.id || '(no-id)');
            }catch(e){ console.error('Telegram notify failed for', f, e && e.message || e); }
          } else {
            console.log('SKIP notify (no TELEGRAM_BOT_TOKEN or chatId):', f, text.replace(/\n/g,' | '));
          }
          // mark processed
          entry.hookProcessed = true;
          entry.hookProcessedAt = Date.now();
          entry.hookProcessedBy = 'scripts/process_sent_tokens.js';
          modified = true;
          totalProcessed++;
        }catch(e){ console.error('entry process error', e); }
      }
      if(modified){
        if(ENABLE_ARCHIVE){ try{ fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8'); console.log('Updated file', p); }catch(e){ console.error('Failed to write',p); } }
        else { console.log('ENABLE_ARCHIVE not set: changes to', p, 'not persisted.'); }
      }
    }
    console.log('Processing complete. Total entries processed:', totalProcessed);
    process.exit(0);
  }catch(e){ console.error('ERROR', e && e.message || e); process.exit(2); }
})();
