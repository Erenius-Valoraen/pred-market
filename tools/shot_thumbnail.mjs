// Rasterise the Devpost thumbnail at exactly 3:2.
//
//   node tools/shot_thumbnail.mjs            (needs the server on :8787)
//
// Devpost wants a 3:2 JPG/PNG/GIF under 5 MB for the gallery thumbnail, and
// crops anything else. web/public/brand/thumbnail.html is authored at
// 1800x1200 so headless Chrome can shoot it one to one - no scaling, no
// guessing where the crop lands.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('web/public/brand/devpost-thumbnail.png');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('no Chrome or Edge found to render with');

fs.rmSync(OUT, { force: true });
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1800,1200',
  // Fonts come from Google Fonts, so give the page real time to fetch them.
  '--virtual-time-budget=12000',
  `--screenshot=${OUT}`,
  'http://localhost:8787/brand/thumbnail.html',
], { stdio: 'inherit' });

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`${OUT}  ${kb} KB`);
