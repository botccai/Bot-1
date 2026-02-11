#!/usr/bin/env node
// Send updated main reply keyboard to all users in users.json
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { Telegram } = require('telegraf');

const USERS_FILE = path.resolve(process.cwd(), 'users.json');
if (!fs.existsSync(USERS_FILE)) {
  console.error('users.json not found in workspace root. Aborting.');
  process.exit(1);
}
const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '{}');
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN not set in environment. Aborting.');
  process.exit(1);
}

let i18n = null;
try { i18n = require('../src/i18n'); } catch (e) { console.warn('Could not load src/i18n, falling back to English labels.'); }
const t = (key, userId) => {
  try { if (i18n && typeof i18n.t === 'function') return i18n.t(key, userId); } catch (e) {}
  // Fallback labels
  const fallback = {
    'main.wallet': '💼 Wallet',
    'main.strategy': '⚙️ Strategy',
    'main.auto_trade': '🤖 Auto Trade',
    'main.invite_friends': '🤝 Invite Friends',
    'main.sniper': 'sniper DEX',
    'main.sniper_cex': 'Sniper CEX',
    'main.language': '🌐 Language',
    'main.keyboard_updated': '✅ Keyboard updated'
  };
  return fallback[key] || key;
};

const tg = new Telegram(token);

(async () => {
  const uids = Object.keys(users || {});
  console.log(`Found ${uids.length} users. Sending keyboard to each (this may take a while)...`);
  for (const uid of uids) {
    try {
      const userId = uid;
      const keyboard = [
        [ t('main.wallet', userId), t('main.strategy', userId) ],
        [ t('main.auto_trade', userId), t('main.invite_friends', userId) ],
        [ t('main.sniper', userId), t('main.sniper_cex', userId) ],
        [ t('main.language', userId) ]
      ].map(row => row.map(text => ({ text })));
      const reply = t('main.keyboard_updated', userId);
      await tg.sendMessage(userId, reply, { reply_markup: { keyboard, resize_keyboard: true } });
      console.log('Sent keyboard to', userId);
      // small delay to avoid hitting rate limits
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.error('Failed to send to', uid, e && e.message ? e.message : e);
    }
  }
  console.log('Done sending keyboards.');
  process.exit(0);
})();
