// web3.js and spl-token expect Node's Buffer. Imported FIRST in main.js, so it
// runs before those modules evaluate.
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
