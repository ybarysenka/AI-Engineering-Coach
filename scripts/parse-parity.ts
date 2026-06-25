/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Parsed-output parity check between two source trees (typically this branch vs. main).
 *
 * Why this exists: a performance refactor of the parser (e.g. the O(n^2) JSONL streaming fix in
 * parser-vscode-files.ts) must change speed only, not the parsed result. There is no golden
 * snapshot in the repo, and the harness itself only lives on the feature branch — so instead of
 * comparing against a committed baseline, it builds the parser from BOTH trees and diffs their
 * canonical output against the same real local logs.
 *
 * How: for each tree it copies scripts/parity-parse-entry.ts in, esbuild-bundles it against that
 * tree's own src/, runs it to emit canonical NDJSON + a SHA-256, then compares the two hashes.
 * Equal hash => byte-for-byte identical parsed output.
 *
 * Run:
 *   npm run parity                       # compares branch vs. the default main checkout
 *   npm run parity -- --main C:\path\to\main-checkout
 *
 * Notes:
 *   - The "main" tree must be a checkout of this repo with node_modules installed.
 *   - The main side runs the unoptimized parser, so a large real log set can take a couple of
 *     minutes there — that slowness is exactly what the branch fixes.
 *   - Output artifacts land in scripts/.parity-out/ (gitignored).
 */

import { spawnSync } from 'child_process';
import { build } from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const branchRoot = path.resolve(__dirname, '..');

function parseMainRoot(): string {
  const args = process.argv.slice(2);
  const i = args.indexOf('--main');
  if (i >= 0 && args[i + 1]) return path.resolve(args[i + 1]);
  if (process.env.PARITY_MAIN) return path.resolve(process.env.PARITY_MAIN);
  return 'C:\\dev\\AI-Engineering-Coach';
}

const mainRoot = parseMainRoot();
const outDir = path.join(branchRoot, 'scripts', '.parity-out');
const entrySrc = fs.readFileSync(path.join(branchRoot, 'scripts', 'parity-parse-entry.ts'), 'utf8');

async function runFor(label: string, root: string): Promise<{ sha: string; ndjson: string }> {
  if (!fs.existsSync(path.join(root, 'src', 'core', 'parser.ts'))) {
    throw new Error(`${label}: no src/core/parser.ts under ${root}`);
  }
  // Inject the identical entry + canonicalizer into the target tree so ONLY the parser differs.
  const tmpEntry = path.join(root, 'scripts', '.parity-tmp-entry.ts');
  fs.writeFileSync(tmpEntry, entrySrc);
  const bundle = path.join(outDir, `${label}.cjs`);
  const ndjson = path.join(outDir, `${label}.ndjson`);
  try {
    await build({
      entryPoints: [tmpEntry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      absWorkingDir: root, // resolve ../src and node_modules from the target tree
      logLevel: 'error',
    });
    // eslint-disable-next-line no-console
    console.log(`\n[${label}] parsing real logs (${root})...`);
    const res = spawnSync(process.execPath, [bundle, ndjson], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`${label}: parse exited with code ${res.status}`);
    const sha = fs.readFileSync(`${ndjson}.sha256`, 'utf8').trim();
    return { sha, ndjson };
  } finally {
    fs.rmSync(tmpEntry, { force: true });
  }
}

function reportFirstDiff(branchNdjson: string, mainNdjson: string): void {
  const bl = fs.readFileSync(branchNdjson, 'utf8').split('\n');
  const ml = fs.readFileSync(mainNdjson, 'utf8').split('\n');
  const n = Math.max(bl.length, ml.length);
  for (let i = 0; i < n; i++) {
    if (bl[i] !== ml[i]) {
      const cut = (s: string | undefined): string => (s === undefined ? '<missing>' : s.slice(0, 400));
      // eslint-disable-next-line no-console
      console.log(`\nFirst difference at line ${i + 1}:`);
      // eslint-disable-next-line no-console
      console.log(`  branch: ${cut(bl[i])}`);
      // eslint-disable-next-line no-console
      console.log(`  main:   ${cut(ml[i])}`);
      break;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n(branch lines=${bl.length}, main lines=${ml.length})`);
}

async function run(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  /* eslint-disable no-console */
  console.log('Parse-parity check');
  console.log(`  branch tree: ${branchRoot}`);
  console.log(`  main tree:   ${mainRoot}`);

  const branch = await runFor('branch', branchRoot);
  const main = await runFor('main', mainRoot);

  console.log(`\nbranch sha256 = ${branch.sha}`);
  console.log(`main   sha256 = ${main.sha}`);

  if (branch.sha === main.sha) {
    console.log('\nPARITY OK — parsed output is byte-for-byte identical across both trees.');
    process.exit(0);
  }
  console.log('\nPARITY FAILED — parsed output differs between the two trees.');
  reportFirstDiff(branch.ndjson, main.ndjson);
  process.exit(1);
  /* eslint-enable no-console */
}

void run();
