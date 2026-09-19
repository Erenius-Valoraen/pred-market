// Connectivity check: can we reach devnet and fund the operator?
import { connection, operatorKeypair, solBalance, ensureSol, explorer } from './chain.js';

const op = operatorKeypair();
console.log('operator :', op.publicKey.toBase58());
console.log('explorer :', explorer('address', op.publicKey.toBase58()));

const version = await connection.getVersion();
console.log('devnet   :', `reachable, solana-core ${version['solana-core']}`);
console.log('balance  :', await solBalance(op.publicKey), 'SOL');

try {
  const bal = await ensureSol(op.publicKey, 1, 1);
  console.log('funded   :', bal, 'SOL');
} catch (e) {
  console.log('FUNDING FAILED:', e.message);
  process.exitCode = 1;
}
