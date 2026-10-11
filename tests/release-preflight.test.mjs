import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRelease } from '../scripts/release-preflight.mjs';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const expected = ['windows10', 'fluent', 'fluent-blue', 'windows11-ribbon']
  .flatMap((theme) => ['x86', 'x64'].map((arch) => ({ name: theme + '-' + arch + '.7z', digest: 'sha256:' + 'c'.repeat(64) })))
  .concat([{ name: 'SHA256SUMS.txt', digest: 'sha256:' + 'd'.repeat(64) }, { name: 'build-provenance.json', digest: 'sha256:' + 'e'.repeat(64) }]);

test('release preflight validates a new tag', () => {
  assert.equal(decideRelease({ currentSha: a, tagSha: null, release: null }).proceed, true);
});
test('release preflight skips a tag from another commit without rebuilding', () => {
  const result = decideRelease({ currentSha: b, tagSha: a, release: { assets: expected } });
  assert.equal(result.proceed, false);
  assert.match(result.reason, /themeRevision/);
});
test('release preflight skips a fully published matching release', () => {
  assert.equal(decideRelease({ currentSha: a, tagSha: a, release: { assets: expected } }).proceed, false);
});
test('release preflight permits recovery of missing assets on matching commit only', () => {
  assert.equal(decideRelease({ currentSha: a, tagSha: a, release: { assets: expected.slice(0, 8) } }).proceed, true);
  assert.equal(decideRelease({ currentSha: a, tagSha: a, release: null }).proceed, true);
});
test('release preflight fails closed for inconsistent release metadata', () => {
  assert.throws(() => decideRelease({ currentSha: a, tagSha: null, release: { assets: [] } }), /without a tag/);
  assert.throws(() => decideRelease({ currentSha: a, tagSha: a, release: { assets: [...expected, expected[0]] } }), /Duplicate/);
  assert.throws(() => decideRelease({ currentSha: a, tagSha: a, release: { assets: [{ name: 'evil.exe', digest: expected[0].digest }] } }), /Unexpected/);
  assert.throws(() => decideRelease({ currentSha: a, tagSha: a, release: { assets: [{ name: expected[0].name, digest: null }] } }), /SHA-256/);
  assert.throws(() => decideRelease({ currentSha: 'not-sha', tagSha: null, release: null }), /Invalid/);
});
