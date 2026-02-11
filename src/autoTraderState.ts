import fs from 'fs';
import path from 'path';

const STATE_PATH = path.join(process.cwd(), 'data', 'auto_trader_state.json');

type TraderState = {
  userId: string;
  mint: string;
  in_pos: boolean;
  entry: number;
  last_sell: number;
  createdAt: number;
  tradeCount?: number;
  lastTradeTs?: number;
  [key: string]: any;
}

function ensureDir(){
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadState(): TraderState[] {
  try{
    if (!fs.existsSync(STATE_PATH)) return [];
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw || '[]');
  }catch(e){
    console.warn('[autoTraderState] failed to load state', e);
    return [];
  }
}

export function saveState(states: TraderState[]){
  try{
    ensureDir();
    fs.writeFileSync(STATE_PATH, JSON.stringify(states || [], null, 2), 'utf8');
  }catch(e){
    console.error('[autoTraderState] failed to save state', e);
  }
}

export function upsertTrader(s: Partial<TraderState>){
  const all = loadState();
  const idx = all.findIndex(x => x.userId === s.userId && x.mint === s.mint);
  s.createdAt = s.createdAt || Date.now();
  if (idx === -1) all.push(Object.assign({}, s as any)); else all[idx] = Object.assign({}, all[idx], s as any);
  saveState(all);
}

export function removeTrader(userId: string, mint: string){
  const all = loadState();
  const filtered = all.filter(x => !(x.userId === userId && x.mint === mint));
  saveState(filtered);
}

export function getAllTraders(){
  return loadState();
}
