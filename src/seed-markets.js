// Markets that exist from minute zero — no team roster required.
//
// Every market carries an explicit, objective resolution rule. A prediction
// market with ambiguous resolution is worthless: traders price the
// resolver's mood instead of the event. If a rule can't be checked from a
// public source at closing ceremony, the market doesn't belong here.

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
    id: 'hw-finalist',
    short: 'Hardware finalist?',
    question: 'Will a hardware project be named a Finalist?',
    outcomes: ['YES', 'NO'],
    subsidy: 200,
    meta: {
      resolves: 'YES if any of the announced Finalists has physical hardware as a core component (not just a phone or laptop).',
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
    id: 'badge-wins',
    short: 'Badge project wins?',
    question: 'Will a project built on the Hacker Badge win any prize?',
    outcomes: ['YES', 'NO'],
    subsidy: 200,
    meta: {
      resolves: 'YES if any prize (sponsor track or finalist) goes to a project whose Devpost lists the Hacker Badge.',
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
