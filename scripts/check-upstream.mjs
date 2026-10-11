import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './core.mjs';
import { compareVersions, lockNeedsUpdate, selectReleaseAssets } from './upstream.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockFile = path.join(root, 'config/7zip.lock.json');
const current = readJson(lockFile);
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': '7-Zip-Filetype-Theme-updater' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const response = await fetch('https://api.github.com/repos/ip7z/7zip/releases/latest', { headers });
if (response.status === 403 || response.status === 429) throw new Error(`GitHub API rate limit (${response.status}); provide GITHUB_TOKEN`);
if (!response.ok) throw new Error(`Official release query failed (${response.status})`);
const release = await response.json();
const next = selectReleaseAssets(release);
next.assets = Object.fromEntries(Object.entries(next.assets).map(([arch, asset]) => [arch, { ...asset, machine: current.assets[arch].machine, binaries: current.assets[arch].binaries }]));
const changed = lockNeedsUpdate(current, next);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `update=${changed}\nversion=${next.version}\n`);
if (!changed) { console.log(`No upstream update: official stable ${current.version} and locked x86/x64 digests match.`); process.exit(0); }
if (compareVersions(next.version, current.version) < 0) { console.log(`Ignoring non-newer upstream version ${next.version}`); process.exit(0); }
fs.writeFileSync(lockFile, `${JSON.stringify({ repository: current.repository, ...next }, null, 2)}\n`);
console.log(`Prepared official 7-Zip ${current.version} -> ${next.version} metadata update.`);
