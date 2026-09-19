// Command-line driver for the market. Every command loads state, acts, saves.
//
//   node src/cli.js seed
//   node src/cli.js register <badgeId> "<name>"
//   node src/cli.js markets
//   node src/cli.js buy <badgeId> <marketId> <outcome#> <spend>
//   node src/cli.js sell <badgeId> <marketId> <outcome#> <shares>
//   node src/cli.js portfolio <badgeId>
//   node src/cli.js leaderboard
//   node src/cli.js resolve <marketId> <winner#>
//   node src/cli.js redeem <badgeId> <marketId>

import { load, save } from './store.js';
import { SEED_MARKETS } from './seed-markets.js';
import { HACK } from './market.js';
import { HOUSE } from './ledger.js';

const fmt = (x, d = 2) => Number(x).toFixed(d);
const bar = (p, w = 24) => '#'.repeat(Math.round(p * w)).padEnd(w, '.');

function printMarket(e, m) {
  const p = e.quote(m.id);
  const tag = m.status === 'resolved' ? `  [RESOLVED: ${m.outcomes[m.winner]}]` : '';
  console.log(`\n  ${m.id}  ${m.question}${tag}`);
  console.log(`  volume ${fmt(m.volume)} HACK   liquidity b=${fmt(m.b, 1)}`);
  m.outcomes.forEach((o, i) => {
    console.log(`    ${i}  ${o.padEnd(20)} ${bar(p[i])} ${fmt(p[i] * 100, 1).padStart(5)}%`);
  });
}

const [cmd, ...args] = process.argv.slice(2);
const e = load();

try {
  switch (cmd) {
    case 'seed': {
      let made = 0;
      for (const def of SEED_MARKETS) {
        if (e.state.markets[def.id]) continue;
        await e.createMarket(def);
        made++;
      }
      console.log(`seeded ${made} market(s); ${Object.keys(e.state.markets).length} total`);
      break;
    }
    case 'register': {
      const [badgeId, name] = args;
      const { user, fresh } = await e.register({ badgeId, name });
      console.log(fresh ? `welcome ${user.name} - 1000 HACK credited` : `${user.name} already registered`);
      break;
    }
    case 'markets': {
      for (const m of Object.values(e.state.markets)) printMarket(e, m);
      console.log(`\n  house float: ${fmt(await e.ledger.balance(HACK, HOUSE))} HACK`);
      break;
    }
    case 'buy': {
      const [badgeId, marketId, o, spend] = args;
      const r = await e.buy({ badgeId, marketId, outcome: Number(o), spend: Number(spend) });
      const m = e.state.markets[marketId];
      console.log(`bought ${fmt(r.shares, 3)} shares of "${m.outcomes[o]}" for ${fmt(r.cost)} HACK`);
      console.log(`price ${fmt(r.before[o] * 100, 1)}% -> ${fmt(r.after[o] * 100, 1)}%`);
      break;
    }
    case 'sell': {
      const [badgeId, marketId, o, shares] = args;
      const r = await e.sell({ badgeId, marketId, outcome: Number(o), shares: Number(shares) });
      console.log(`sold ${shares} shares for ${fmt(r.refund)} HACK`);
      break;
    }
    case 'portfolio': {
      const pf = await e.portfolio(args[0]);
      console.log(`\n  cash      ${fmt(pf.cash)} HACK`);
      for (const p of pf.positions) {
        console.log(`  ${p.marketId.padEnd(14)} ${p.outcome.padEnd(20)} ${fmt(p.shares, 3)} sh  ~${fmt(p.value)} HACK`);
      }
      console.log(`  net worth ${fmt(pf.netWorth)} HACK`);
      break;
    }
    case 'leaderboard': {
      const rows = await e.leaderboard();
      console.log('');
      rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(24)} ${fmt(r.netWorth)} HACK`));
      break;
    }
    case 'resolve': {
      const [marketId, w] = args;
      const m = await e.resolve(marketId, Number(w));
      console.log(`resolved ${marketId} -> ${m.outcomes[m.winner]}`);
      break;
    }
    case 'redeem': {
      const [badgeId, marketId] = args;
      const r = await e.redeem({ badgeId, marketId });
      console.log(`paid out ${fmt(r.payout)} HACK`);
      break;
    }
    default:
      console.log('commands: seed | register | markets | buy | sell | portfolio | leaderboard | resolve | redeem');
  }
  save(e);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}
