// Load/save the whole market (engine state + ledger) as one JSON file.
// Writes go to a temp file then rename, so a crash mid-write can never
// leave a half-written, corrupt state file behind.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './chain.js';
import { MarketEngine } from './market.js';
import { MemoryLedger } from './ledger.js';

export const STATE_FILE = path.join(DATA_DIR, 'state.json');

export function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return new MarketEngine(new MemoryLedger());
  }
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return new MarketEngine(MemoryLedger.fromJSON(raw.ledger), raw.engine);
}

export function save(engine) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ engine: engine.state, ledger: engine.ledger }, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
