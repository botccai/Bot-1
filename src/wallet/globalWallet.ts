import { loadKeypair } from '../wallet';
import { Keypair } from '@solana/web3.js';

// Read global bot secret from common env vars used across scripts
export function getGlobalSecretRaw(): string | null {
  const pkEnv = process.env.BOT_SECRET || process.env.BOT_KEYPAIR || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_RAW || '';
  if (!pkEnv) return null;
  return String(pkEnv);
}

export function getGlobalKeypair(): Keypair | null {
  const s = getGlobalSecretRaw();
  if (!s) return null;
  try {
    return loadKeypair(s as any) as Keypair;
  } catch (e) {
    try {
      // try parsing JSON
      const parsed = JSON.parse(s);
      return loadKeypair(parsed as any) as Keypair;
    } catch (_e) {
      return null;
    }
  }
}

export function hasGlobalSecret(): boolean {
  return !!getGlobalSecretRaw();
}
