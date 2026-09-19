// Two ways to hold your own keys. Both are self-custodial: the server never
// sees a private key and never signs a trade.
//
//   phantom  the Phantom browser extension / mobile in-app browser
//   burner   a keypair generated in THIS browser and kept in localStorage.
//            Zero install. The key never leaves the device - but clearing
//            site data or switching devices loses it, and we say so in the UI.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const BURNER_KEY = 'htnmkt.burner.v1';
const MODE_KEY = 'htnmkt.wallet.mode';

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function safeDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

export function phantomProvider() {
  const p = window.phantom?.solana ?? window.solana;
  return p?.isPhantom ? p : null;
}

export async function connectPhantom() {
  const p = phantomProvider();
  if (!p) throw new Error('Phantom not found. Install it, or use a burner wallet.');
  const { publicKey } = await p.connect();
  safeSet(MODE_KEY, 'phantom');
  return {
    kind: 'phantom',
    publicKey,
    signTransaction: (tx) => p.signTransaction(tx),
    disconnect: async () => { await p.disconnect(); safeDel(MODE_KEY); },
  };
}

export function connectBurner() {
  let secret = safeGet(BURNER_KEY);
  let kp;
  if (secret) {
    kp = Keypair.fromSecretKey(bs58.decode(secret));
  } else {
    kp = Keypair.generate();
    safeSet(BURNER_KEY, bs58.encode(kp.secretKey));
  }
  safeSet(MODE_KEY, 'burner');
  return {
    kind: 'burner',
    publicKey: kp.publicKey,
    signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    disconnect: async () => { safeDel(MODE_KEY); },   // keep the key: it holds funds
    exportSecret: () => bs58.encode(kp.secretKey),
  };
}

/** Reconnect silently on page load if the user connected before. */
export async function restore() {
  const mode = safeGet(MODE_KEY);
  if (mode === 'burner' && safeGet(BURNER_KEY)) return connectBurner();
  if (mode === 'phantom' && phantomProvider()) {
    try {
      const p = phantomProvider();
      const { publicKey } = await p.connect({ onlyIfTrusted: true });
      return { kind: 'phantom', publicKey, signTransaction: (tx) => p.signTransaction(tx),
        disconnect: async () => { await p.disconnect(); safeDel(MODE_KEY); } };
    } catch { return null; }
  }
  return null;
}
