// Markets that exist from minute zero — no team roster required.
//
// Every market carries an explicit, objective resolution rule. A prediction
// market with ambiguous resolution is worthless: traders price the
// resolver's mood instead of the event. If a rule can't be checked from a
// public source at closing ceremony, the market doesn't belong here.

// Questions that turned out to have an obvious answer, replaced above rather
// than reworded: the question text is hashed into the market's creation
// transaction, so editing it in place would break its own commitment. These
// stay on-chain and keep their history; they just leave the board.
export const RETIRED_SEEDS = {
  'hw-finalist': 'near-certain YES: replaced by hw-finalist-count',
  'badge-wins': 'a badge prize exists, so this is ~100%: replaced by badge-radio',
};

export const SEED_MARKETS = [
  {
    id: 'submissions',
    short: 'Devpost project count',
    question: 'How many projects will be submitted to HTN 2026 on Devpost?',
    outcomes: ['Under 200', '200-299', '300-399', '400+'],
    subsidy: 300,
    meta: {
      resolves: 'Project count shown on hackthenorth2026.devpost.com/project-gallery after the Sunday 8 AM deadline.',
    },
  },
  {
    id: 'hw-finalist-count',
    short: 'Hardware finalists',
    question: 'How many of the Finalists will be hardware projects?',
    outcomes: ['None', 'One', 'Two', 'Three or more'],
    subsidy: 250,
    meta: {
      resolves: 'Count of announced Finalists with physical hardware as a core component '
        + '(not just a phone or laptop), from the closing ceremony list.',
    },
  },
  {
    id: 'grand-category',
    short: 'Best Overall category',
    question: 'What kind of project wins Best Overall?',
    outcomes: ['AI / agents', 'Hardware / robotics', 'Web or mobile app', 'Dev tools / infra', 'Other'],
    subsidy: 300,
    meta: {
      resolves: "Category of the grand-prize winner's primary technical contribution, per its Devpost description.",
    },
  },
  {
    id: 'badge-radio',
    short: 'Badge prize uses radio?',
    question: "Will the Hacker Badge prize go to a project that uses the badge's radio?",
    outcomes: ['YES', 'NO'],
    subsidy: 200,
    meta: {
      resolves: "YES if the winning badge project's Devpost or demo shows badge-to-badge or "
        + 'badge-to-host wireless communication, rather than only the screen, buttons and LEDs.',
    },
  },
  {
    id: 'qnx-pi',
    short: 'QNX winner on a Pi?',
    question: 'Will the QNX prize winner run on a Raspberry Pi?',
    outcomes: ['YES', 'NO'],
    subsidy: 150,
    meta: {
      resolves: 'YES if the QNX track winner deploys to Raspberry Pi hardware (vs. a QNX VM or other board).',
    },
  },
  {
    id: 'rox-solo',
    short: 'Rox $10k to team of 4?',
    question: 'Will the Rox $10k grand prize go to a team of 4?',
    outcomes: ['YES', 'NO'],
    subsidy: 150,
    meta: {
      resolves: 'Team size listed on the winning Devpost submission.',
    },
  },
  {
    id: 'this-market',
    short: 'This market wins?',
    question: 'Will this prediction market win a prize?',
    outcomes: ['YES', 'NO'],
    subsidy: 250,
    meta: {
      resolves: 'YES if HTN Market wins any prize at Hack the North 2026. Yes, you can bet on us.',
    },
  },
];
