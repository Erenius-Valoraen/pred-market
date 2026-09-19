// Settlement backends. The market engine only ever talks to this interface,
// so its logic is testable offline and the on-chain backend is a drop-in.
//
//   mint(asset, owner, amount)            create tokens
//   transfer(asset, from, to, amount)     move tokens
//   burn(asset, owner, amount)            destroy tokens
//   balance(asset, owner) -> number
//
// `asset` is 'HACK' (the play-money currency) or `${marketId}:${outcome}`.
// `owner` is a string id: a badge id, or HOUSE for the market maker.

export const HOUSE = '__house__';
const EPS = 1e-9;

export class MemoryLedger {
  constructor() {
    this.bal = new Map();          // `${asset}|${owner}` -> amount
    this.log = [];                 // every movement, for auditing
  }

  #k(asset, owner) { return `${asset}|${owner}`; }

  async balance(asset, owner) {
    return this.bal.get(this.#k(asset, owner)) ?? 0;
  }

  async mint(asset, owner, amount) {
    if (!(amount >= 0)) throw new RangeError(`mint amount ${amount}`);
    const k = this.#k(asset, owner);
    this.bal.set(k, (this.bal.get(k) ?? 0) + amount);
    this.log.push({ op: 'mint', asset, owner, amount });
  }

  async transfer(asset, from, to, amount) {
    if (!(amount >= 0)) throw new RangeError(`transfer amount ${amount}`);
    const have = await this.balance(asset, from);
    if (have + EPS < amount) {
      throw new Error(`insufficient ${asset}: ${from} has ${have}, needs ${amount}`);
    }
    this.bal.set(this.#k(asset, from), have - amount);
    const k = this.#k(asset, to);
    this.bal.set(k, (this.bal.get(k) ?? 0) + amount);
    this.log.push({ op: 'transfer', asset, from, to, amount });
  }

  async burn(asset, owner, amount) {
    const have = await this.balance(asset, owner);
    if (have + EPS < amount) {
      throw new Error(`cannot burn ${amount} ${asset}: ${owner} has ${have}`);
    }
    this.bal.set(this.#k(asset, owner), have - amount);
    this.log.push({ op: 'burn', asset, owner, amount });
  }

  toJSON() {
    return { kind: 'memory', bal: Object.fromEntries(this.bal) };
  }

  static fromJSON(o) {
    const l = new MemoryLedger();
    l.bal = new Map(Object.entries(o?.bal ?? {}));
    return l;
  }
}
