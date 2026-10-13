// The repo's About panel (description, website, topics) lives in repo.json and is pushed to GitHub from here.
//
//   node scripts/readme/meta.mjs --lint    validate repo.json offline (pull requests run this)
//   node scripts/readme/meta.mjs --check   compare repo.json with GitHub and fetch every remote README link;
//                                          exits 1 on drift or a dead link (pushes to main run this)
//   node scripts/readme/meta.mjs --apply   push repo.json to GitHub (needs gh logged in), then --check
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT } from './facts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'ryanportfolio/Firefox-Efficient';
const meta = JSON.parse(fs.readFileSync(path.join(HERE, 'repo.json'), 'utf8'));

function lint() {
  const errs = [];
  if (typeof meta.description !== 'string' || !meta.description.trim()) errs.push('description is empty');
  else if (meta.description.length > 350) errs.push(`description is ${meta.description.length} chars (max 350)`);
  if (typeof meta.homepage !== 'string') errs.push('homepage must be a string ("" for none)');
  else if (meta.homepage && !/^https:\/\//.test(meta.homepage)) errs.push('homepage must start with https://');
  if (!Array.isArray(meta.topics)) errs.push('topics must be an array');
  else {
    if (meta.topics.length > 20) errs.push(`${meta.topics.length} topics (max 20)`);
    for (const t of meta.topics) if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(t)) errs.push(`bad topic "${t}"`);
    if (new Set(meta.topics).size !== meta.topics.length) errs.push('duplicate topics');
  }
  if (/—/.test(meta.description || '')) errs.push('description contains an em dash');
  for (const e of errs) console.error(`FAIL repo.json: ${e}`);
  return errs.length;
}

const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] });

async function linkOk(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'follow' });
      if (res.status < 400) return true;
    } catch { /* try GET, then give up */ }
  }
  return false;
}

async function check() {
  let bad = lint();
  const live = JSON.parse(gh(['api', `repos/${REPO}`]));
  if ((live.description || '') !== meta.description) { console.error(`FAIL About: description on GitHub is ${JSON.stringify(live.description)}`); bad++; }
  if ((live.homepage || '') !== meta.homepage) { console.error(`FAIL About: homepage on GitHub is ${JSON.stringify(live.homepage)}`); bad++; }
  const topics = [...(live.topics || [])].sort().join(',');
  if (topics !== [...meta.topics].sort().join(',')) { console.error(`FAIL About: topics on GitHub are ${topics || '(none)'}`); bad++; }

  // Real links only: drop fenced code and inline code first, where URLs are examples (example.com/inbox).
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const urls = [...new Set([...readme.matchAll(/https?:\/\/[^\s)>"`]+/g)].map((m) => m[0].replace(/[.,;]+$/, '')))];
  for (const url of urls) if (!(await linkOk(url))) { console.error(`FAIL link: ${url}`); bad++; }
  if (!bad) console.error(`meta: About panel matches repo.json; ${urls.length} remote link(s) answer`);
  return bad;
}

function apply() {
  if (lint()) return 1;
  gh(['api', '--method', 'PATCH', `repos/${REPO}`, '-f', `description=${meta.description}`, '-f', `homepage=${meta.homepage}`]);
  gh(['api', '--method', 'PUT', `repos/${REPO}/topics`, '--input', '-'], JSON.stringify({ names: meta.topics }));
  console.error('meta: applied repo.json to GitHub');
  return 0;
}

const mode = process.argv[2];
if (mode === '--lint') process.exitCode = lint() ? 1 : 0;
else if (mode === '--check') process.exitCode = (await check()) ? 1 : 0;
else if (mode === '--apply') process.exitCode = apply() || (await check()) ? 1 : 0;
else { console.error('usage: meta.mjs --lint | --check | --apply'); process.exitCode = 2; }
