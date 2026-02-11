import fs from 'fs';
import path from 'path';
import { autoExecuteStrategyForUser } from '../src/autoStrategyExecutor';

async function main(){
  // safety: very small buy amount
  process.env.LIVE_TRADES = 'true';
  process.env.ALLOW_TRADE_WITHOUT_SIGNAL = 'true';

  const usersPath = path.join(process.cwd(), 'users.json');
  const usersRaw = fs.readFileSync(usersPath, 'utf8');
  const users = JSON.parse(usersRaw);
  const userId = process.env.TELEGRAM_USER_ID || Object.keys(users)[0];
  const user = users[userId];
  if (!user) {
    console.error('User not found in users.json', userId);
    process.exit(1);
  }

  // clone and set a tiny buy amount to limit risk
  const testUser = JSON.parse(JSON.stringify(user));
  testUser.id = userId;
  testUser.strategy = testUser.strategy || {};
  testUser.strategy.buyAmount = Number(process.env.TEST_BUY_AMOUNT || 0.001);
  testUser.strategy.enabled = true;

  const USDC_MINT = process.env.TEST_TOKEN_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const tokens = [{ mint: USDC_MINT }];

  console.log('Starting live test buy for user', userId, 'mint', USDC_MINT, 'amount', testUser.strategy.buyAmount);
  try{
    const res = await autoExecuteStrategyForUser(testUser, tokens, 'buy', { simulateOnly: false, listenerBypass: true, forceAllowSignal: true });
    console.log('Result:', JSON.stringify(res, null, 2));
  }catch(e:any){
    console.error('Test failed:', e?.message || e);
  }
}

main().then(()=>process.exit(0)).catch(e=>{ console.error(e); process.exit(2); });
