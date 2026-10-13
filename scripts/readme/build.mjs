// Builds README.md and its art. Run after changing src/, body.md or the panels.
//
//   node scripts/readme/build.mjs          regenerate assets/readme/*.svg and README.md, verify both,
//                                          and lint repo.json
//   node scripts/readme/build.mjs --check  write nothing; fail if any generated file is stale or a check
//                                          fails (CI runs this on every pull request)
//
// No items.json or cards.mjs: this README lists no inventory of separate things, so there are no cards.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, readFacts } from './facts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');

// Fail before generating anything if the facts the page depends on cannot be read.
readFacts();

const steps = [
  ['panels.mjs', check ? ['--check'] : [], 'SVG panels from the add-on source'],
  ['readme.mjs', check ? ['--check'] : [], 'README.md and its own invariants'],
  ['meta.mjs', ['--lint'], 'About panel: repo.json shape (--check runs on pushes to main)'],
];
for (const [file, args, what] of steps) {
  process.stderr.write(`\n-> ${file} ${args.join(' ')}  (${what})\n`);
  try {
    execFileSync(process.execPath, [path.join(HERE, file), ...args], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    process.stderr.write(`\nbuild: ${file} failed\n`);
    process.exitCode = 1;
    break;
  }
}
