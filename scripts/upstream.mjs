export function parseVersion(value) {
  const match = /^([1-9]\d*)\.(\d{2})$/.exec(value ?? '');
  if (!match) throw new Error(`Malformed stable 7-Zip version: ${value}`);
  return [Number(match[1]), Number(match[2])];
}
export function compareVersions(a, b) {
  const av = parseVersion(a), bv = parseVersion(b);
  return av[0] - bv[0] || av[1] - bv[1];
}
export function selectReleaseAssets(release) {
  if (release.draft || release.prerelease || !release.tag_name) throw new Error('Latest upstream release is draft, prerelease, or has no tag');
  const version = release.tag_name;
  parseVersion(version);
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.html_url !== `https://github.com/ip7z/7zip/releases/tag/${version}`) throw new Error(`Official release identity metadata is invalid for ${version}`);
  const expected = { x86: `7z${version.replace('.', '')}.exe`, x64: `7z${version.replace('.', '')}-x64.exe` };
  const assets = {};
  for (const [arch, filename] of Object.entries(expected)) {
    const asset = release.assets?.find((item) => item.name === filename);
    const match = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest ?? '');
    if (!asset || !match || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !asset.browser_download_url?.startsWith('https://github.com/ip7z/7zip/releases/download/')) throw new Error(`Official ${arch} asset metadata missing or invalid for ${version}`);
    assets[arch] = { filename, url: asset.browser_download_url, size: asset.size, sha256: match[1].toLowerCase() };
  }
  const extractorAsset = release.assets?.find((item) => item.name === '7zr.exe');
  const extractorHash = /^sha256:([a-f0-9]{64})$/i.exec(extractorAsset?.digest ?? '');
  if (!extractorAsset || !extractorHash || !Number.isSafeInteger(extractorAsset.size) || !extractorAsset.browser_download_url?.startsWith('https://github.com/ip7z/7zip/releases/download/')) throw new Error(`Official extractor metadata missing or invalid for ${version}`);
  return { version, tag: release.tag_name, releaseId: release.id, releaseUrl: release.html_url, stable: true, assets, extractor: { filename: '7zr.exe', url: extractorAsset.browser_download_url, size: extractorAsset.size, sha256: extractorHash[1].toLowerCase() } };
}
export function lockNeedsUpdate(lock, current) {
  if (compareVersions(current.version, lock.version) < 0) return false;
  return current.version !== lock.version
    || current.releaseId !== lock.releaseId
    || current.releaseUrl !== lock.releaseUrl
    || Object.entries(current.assets).some(([arch, asset]) => lock.assets?.[arch]?.sha256 !== asset.sha256 || lock.assets?.[arch]?.size !== asset.size || lock.assets?.[arch]?.url !== asset.url)
    || current.extractor?.sha256 !== lock.extractor?.sha256
    || current.extractor?.size !== lock.extractor?.size
    || current.extractor?.url !== lock.extractor?.url;
}
export function releaseTag(upstream, revision) { parseVersion(upstream); if (!Number.isInteger(revision) || revision < 1) throw new Error('Theme revision must be a positive integer'); return `7zip-${upstream}-theme.${revision}`; }

export function publicationAction({ tagExists, releaseExists, requestedAssets, publishedAssets = {}, commit, publishedCommit }) {
  if (!tagExists && !releaseExists) return 'publish';
  if (tagExists && releaseExists && commit === publishedCommit) {
    const wanted = Object.keys(requestedAssets).sort(), existing = Object.keys(publishedAssets).sort();
    if (JSON.stringify(wanted) === JSON.stringify(existing) && wanted.every((name) => requestedAssets[name] === publishedAssets[name])) return 'noop';
  }
  throw new Error('Existing tag/release differs from the validated artifact set; refusing to overwrite or reassign it');
}
