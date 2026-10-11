import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedAssets = [
  ...['windows10', 'fluent', 'fluent-blue', 'windows11-ribbon'].flatMap((theme) =>
    ['x86', 'x64'].map((arch) => theme + '-' + arch + '.7z')),
  'SHA256SUMS.txt',
  'build-provenance.json',
];

/** Decide whether to build and publish for the current upstream/revision tag. */
export function decideRelease({ currentSha, tagSha, release }) {
  const shaPattern = /^[a-f0-9]{40}$/;
  if (!shaPattern.test(currentSha) || (tagSha !== null && !shaPattern.test(tagSha))) {
    throw new Error('Invalid commit or tag SHA');
  }
  if (!tagSha && release) throw new Error('Release exists without a tag');
  if (!tagSha) return { proceed: true, reason: 'New tag: validate and publish' };
  if (tagSha !== currentSha) {
    return { proceed: false, reason: 'Existing immutable tag belongs to an earlier commit; increment themeRevision to publish changes' };
  }
  if (!release) return { proceed: true, reason: 'Matching tag without release: validate before recovery' };
  if (!Array.isArray(release.assets)) throw new Error('Unable to inspect existing release assets');
  const names = release.assets.map((asset) => asset.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate existing release assets');
  if (names.some((name) => !expectedAssets.includes(name))) throw new Error('Unexpected existing release assets');
  if (release.assets.some((asset) => !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? ''))) {
    throw new Error('Existing release asset lacks a valid SHA-256 digest');
  }
  const missing = expectedAssets.filter((name) => !names.includes(name));
  if (missing.length) {
    return { proceed: true, reason: 'Matching release is incomplete; validate and resume missing assets: ' + missing.join(', ') };
  }
  return { proceed: false, reason: 'Exact tag already has all ten assets; no new release necessary' };
}

async function getResource(repository, resource, headers) {
  const response = await fetch('https://api.github.com/repos/' + repository + '/' + resource, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('GitHub API ' + resource + ' returned HTTP ' + response.status);
  return response.json();
}

async function tagCommit(repository, tag, headers) {
  const ref = await getResource(repository, 'git/ref/tags/' + encodeURIComponent(tag), headers);
  if (!ref) return null;
  let target = ref.object;
  for (let i = 0; i < 4 && target?.type === 'tag'; i++) {
    const tagObject = await getResource(repository, 'git/tags/' + target.sha, headers);
    if (!tagObject) throw new Error('Tag points to missing annotated tag object');
    target = tagObject.object;
  }
  if (target?.type !== 'commit') throw new Error('Tag does not resolve to a commit');
  return target.sha;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository ?? '')) throw new Error('Invalid GITHUB_REPOSITORY');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'config/7zip.lock.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/release.json'), 'utf8'));
  if (!/^\d+\.\d{2}$/.test(lock.version) || !Number.isSafeInteger(config.themeRevision) || config.themeRevision < 1) {
    throw new Error('Invalid upstream version or theme revision');
  }
  const tag = '7zip-' + lock.version + '-theme.' + config.themeRevision;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '7-Zip-Filetype-Theme-release-preflight',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const tagSha = await tagCommit(repository, tag, headers);
  const release = await getResource(repository, 'releases/tags/' + encodeURIComponent(tag), headers);
  if (release && (release.tag_name !== tag || release.draft || release.prerelease)) {
    throw new Error('Existing release metadata does not match expected published tag');
  }
  const result = decideRelease({ currentSha: sha, tagSha, release });
  console.log('Release preflight for ' + tag + ': ' + result.reason);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'proceed=' + result.proceed + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Release preflight: ' + tag + '\n\n' + result.reason + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('Release preflight failed: ' + error.message); process.exitCode = 1; });
}
