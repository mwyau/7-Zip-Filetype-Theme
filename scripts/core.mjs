import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as PE from 'pe-library';
import * as ResEdit from 'resedit';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export function verifyAsset(data, expected, label = 'asset') {
  if (data.length !== expected.size) throw new Error(`${label}: size mismatch (${data.length} != ${expected.size})`);
  const actual = sha256(data);
  if (actual !== expected.sha256) throw new Error(`${label}: SHA-256 mismatch (${actual})`);
  return actual;
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

export function validateManifest(manifest, root = process.cwd()) {
  if (!Number.isInteger(manifest.resourceLanguage) || !Array.isArray(manifest.filetypes) || manifest.filetypes.length === 0) throw new Error('Invalid theme manifest shape');
  const slugs = new Set();
  for (const theme of manifest.filetypes) {
    if (!theme.name || !/^[a-z0-9-]+$/.test(theme.slug) || slugs.has(theme.slug)) throw new Error(`Invalid or duplicate theme slug: ${theme.slug}`);
    slugs.add(theme.slug);
    if (!Array.isArray(theme.groups) || theme.groups.length === 0) throw new Error(`${theme.slug}: no icon groups`);
    const ids = new Set();
    for (const [id, source] of theme.groups) {
      if (!Number.isInteger(id) || id < 0 || ids.has(id)) throw new Error(`${theme.slug}: duplicate or invalid icon-group ID ${id}`);
      ids.add(id);
      if (!source || !fs.existsSync(path.join(root, theme.artwork, source))) throw new Error(`${theme.slug}: missing artwork ${source}`);
    }
    if (ids.size !== 27 || Array.from({ length: 27 }, (_, i) => ids.has(i)).some((found) => !found)) throw new Error(`${theme.slug}: must map every icon group 0–26 exactly once`);
  }
  const ribbon = manifest.ribbon;
  if (!ribbon || !Array.isArray(ribbon.bitmaps) || new Set(ribbon.bitmaps).size !== ribbon.bitmaps.length) throw new Error('Invalid ribbon bitmap mapping');
  for (const id of ribbon.bitmaps) if (!fs.existsSync(path.join(root, ribbon.artwork, `Bitmap${id}.res`))) throw new Error(`Missing ribbon Bitmap${id}.res`);
  return true;
}

function readResName(buffer, state, limit) {
  if (state.offset + 2 > limit) throw new Error('Truncated .res type/name field');
  const first = buffer.readUInt16LE(state.offset);
  if (first === 0xffff) {
    if (state.offset + 4 > limit) throw new Error('Truncated .res ordinal field');
    const value = buffer.readUInt16LE(state.offset + 2); state.offset += 4;
    return { value, ordinal: true };
  }
  let value = '';
  while (state.offset + 2 <= limit) {
    const code = buffer.readUInt16LE(state.offset); state.offset += 2;
    if (code === 0) return { value, ordinal: false };
    value += String.fromCharCode(code);
  }
  throw new Error('Unterminated .res name field');
}

export function parseRes(input, expectedId) {
  const buffer = Buffer.from(input); let offset = 0; const records = [];
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) throw new Error('Truncated .res record header');
    const dataSize = buffer.readUInt32LE(offset), headerSize = buffer.readUInt32LE(offset + 4);
    if (headerSize < 24 || headerSize > buffer.length - offset || dataSize > buffer.length - offset - headerSize) throw new Error('Invalid .res record boundary');
    const state = { offset: offset + 8 };
    const type = readResName(buffer, state, offset + headerSize);
    const id = readResName(buffer, state, offset + headerSize);
    state.offset = (state.offset + 3) & ~3;
    if (state.offset + 16 !== offset + headerSize) throw new Error('Unexpected .res header layout');
    const dataVersion = buffer.readUInt32LE(state.offset);
    const memoryFlags = buffer.readUInt16LE(state.offset + 4);
    const language = buffer.readUInt16LE(state.offset + 6);
    const version = buffer.readUInt32LE(state.offset + 8);
    const characteristics = buffer.readUInt32LE(state.offset + 12);
    const nullHeader = dataSize === 0 && type.ordinal && id.ordinal && type.value === 0 && id.value === 0;
    if (nullHeader && records.length === 0) {
      offset = (offset + headerSize + 3) & ~3;
      continue;
    }
    if (!type.ordinal || type.value !== 2 || !id.ordinal || id.value !== expectedId) throw new Error(`Unexpected .res record type/id; expected RT_BITMAP/${expectedId}`);
    if (dataVersion !== 0 || version !== 0 || characteristics !== 0 || !Number.isInteger(language)) throw new Error('Unexpected .res metadata');
    const start = offset + headerSize;
    const payload = Buffer.from(buffer.subarray(start, start + dataSize));
    // BITMAPINFOHEADER is the required DIB prefix for RT_BITMAP; reject empty/obviously malformed payloads.
    if (payload.length < 40 || payload.readUInt32LE(0) < 40 || payload.readUInt32LE(0) > payload.length) throw new Error(`Invalid RT_BITMAP payload ${expectedId}`);
    records.push({ type: 2, id: id.value, lang: language, bin: payload });
    offset = (start + dataSize + 3) & ~3;
  }
  if (offset !== buffer.length || records.length !== 1) throw new Error(`Expected exactly one RT_BITMAP/${expectedId} record`);
  return records[0];
}

function key(entry) { return `${entry.type}:${entry.id}:${entry.lang}`; }
function entriesMap(entries) { return new Map(entries.map((entry) => [key(entry), Buffer.from(entry.bin)])); }
function iconGroups(entries) { return ResEdit.Resource.IconGroupEntry.fromEntries(entries); }
function assertResourceKeys(entries) {
  const seen = new Set();
  for (const entry of entries) { const k = key(entry); if (seen.has(k)) throw new Error(`Duplicate resource key ${k}`); seen.add(k); }
}
function assertIconIntegrity(entries) {
  const groups = iconGroups(entries), refs = new Set();
  for (const group of groups) {
    for (const icon of group.icons) {
      const k = `3:${icon.iconID}:${group.lang}`;
      if (!entries.some((entry) => key(entry) === k)) throw new Error(`Dangling RT_ICON reference ${k} from group ${group.id}`);
      refs.add(k);
    }
  }
  const orphan = entries.find((entry) => entry.type === 3 && !refs.has(key(entry)));
  if (orphan) throw new Error(`Orphan RT_ICON resource ${key(orphan)}`);
}
function checkPeSafety(beforeExe, afterExe) {
  const before = new Map(beforeExe.getAllSections().map((s) => [s.info.name, s]));
  for (const section of afterExe.getAllSections()) {
    const prior = before.get(section.info.name);
    if (!prior) throw new Error(`Unexpected PE section added: ${section.info.name}`);
    if (!['.rsrc', '.reloc'].includes(section.info.name) && !Buffer.from(section.data).equals(Buffer.from(prior.data))) throw new Error(`Unrelated PE section modified: ${section.info.name}`);
  }
  for (const section of before.values()) if (!afterExe.getAllSections().some((s) => s.info.name === section.info.name)) throw new Error(`PE section removed: ${section.info.name}`);
  const dirsA = beforeExe.newHeader.optionalHeaderDataDirectory;
  const dirsB = afterExe.newHeader.optionalHeaderDataDirectory;
  // Directory RVAs for exports/imports/exceptions/TLS/load config/IAT remain stable.
  for (const index of [0, 1, 3, 9, 10, 12]) if (JSON.stringify(dirsA.get(index)) !== JSON.stringify(dirsB.get(index))) throw new Error(`PE data directory ${index} changed`);
  // The resource editor may move/resize the base-relocation directory as sections are laid out.
  // Compare its logical relocation blocks independently to prove loader fixups are unchanged.
  const relocations = (exe, directory) => {
    const dir = directory.get(5); if (!dir.size) return [];
    const section = exe.getAllSections().find((item) => dir.virtualAddress >= item.info.virtualAddress && dir.virtualAddress < item.info.virtualAddress + item.info.sizeOfRawData);
    if (!section) throw new Error('Base relocation directory does not map to a PE section');
    const start = dir.virtualAddress - section.info.virtualAddress;
    if (start + dir.size > section.data.byteLength) throw new Error('Base relocation directory exceeds its PE section');
    const bin = Buffer.from(section.data).subarray(start, start + dir.size), result = [];
    let offset = 0;
    while (offset + 8 <= bin.length) {
      const page = bin.readUInt32LE(offset), blockSize = bin.readUInt32LE(offset + 4);
      if (page === 0 && blockSize === 0 && bin.subarray(offset).every((byte) => byte === 0)) break;
      if (blockSize < 8 || blockSize % 2 !== 0 || offset + blockSize > bin.length) throw new Error('Malformed PE base-relocation block');
      const entries = []; for (let p = offset + 8; p < offset + blockSize; p += 2) entries.push(bin.readUInt16LE(p));
      result.push([page, entries]); offset += blockSize;
    }
    if (offset < bin.length && !bin.subarray(offset).every((byte) => byte === 0)) throw new Error('Unexpected trailing base-relocation data');
    return result;
  };
  if (JSON.stringify(relocations(beforeExe, dirsA)) !== JSON.stringify(relocations(afterExe, dirsB))) throw new Error('PE base-relocation records changed');
  // Resource editing invalidates Authenticode by changing signed bytes; no original signature is claimed.
  void dirsA.get(4); void dirsB.get(4);
}

export function patchIcons(input, theme, language) {
  const original = PE.NtExecutable.from(input, { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(original);
  assertResourceKeys(resources.entries);
  const before = entriesMap(resources.entries);
  const intended = new Set();
  for (const [id, filename] of theme.groups) {
    const group = iconGroups(resources.entries).find((entry) => Number(entry.id) === id && Number(entry.lang) === language);
    if (!group) throw new Error(`${theme.slug}: required RT_GROUP_ICON/${id}/${language} is missing`);
    intended.add(`14:${id}:${language}`);
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(theme.artwork, filename)));
    if (!iconFile.icons.length) throw new Error(`ICO has no images: ${filename}`);
    for (const icon of group.icons) intended.add(`3:${icon.iconID}:${language}`);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, iconFile.icons.map((item) => item.data));
    const replacement = iconGroups(resources.entries).find((entry) => Number(entry.id) === id && Number(entry.lang) === language);
    if (!replacement) throw new Error(`${theme.slug}: group ${id} disappeared during replacement`);
    for (const icon of replacement.icons) intended.add(`3:${icon.iconID}:${language}`);
  }
  assertResourceKeys(resources.entries); assertIconIntegrity(resources.entries); resources.outputResource(original);
  const output = Buffer.from(original.generate());
  const checkedExe = PE.NtExecutable.from(output); checkPeSafety(PE.NtExecutable.from(input, { ignoreCert: true }), checkedExe);
  const checked = PE.NtExecutableResource.from(checkedExe); assertResourceKeys(checked.entries); assertIconIntegrity(checked.entries);
  const after = entriesMap(checked.entries), changes = diffResourceMaps(before, after, (k) => intended.has(k));
  return { output, changes, machine: checkedExe.newHeader.fileHeader.machine };
}

export function patchBitmaps(input, bitmapFiles, expectedIds, language) {
  const original = PE.NtExecutable.from(input, { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(original); assertResourceKeys(resources.entries); const before = entriesMap(resources.entries);
  const intended = new Set();
  for (const id of expectedIds) {
    const record = parseRes(fs.readFileSync(bitmapFiles(id)), id);
    if (record.lang !== language) throw new Error(`Bitmap ${id} language ${record.lang} != ${language}`);
    const k = key(record);
    if (!before.has(k)) throw new Error(`Required RT_BITMAP/${id}/${language} is missing`);
    intended.add(k); resources.replaceResourceEntry({ ...record, bin: record.bin.buffer.slice(record.bin.byteOffset, record.bin.byteOffset + record.bin.byteLength) });
  }
  resources.outputResource(original); const output = Buffer.from(original.generate());
  const checkedExe = PE.NtExecutable.from(output); checkPeSafety(PE.NtExecutable.from(input, { ignoreCert: true }), checkedExe);
  const after = entriesMap(PE.NtExecutableResource.from(checkedExe).entries);
  return { output, changes: diffResourceMaps(before, after, (k) => intended.has(k)), machine: checkedExe.newHeader.fileHeader.machine };
}

export function diffResourceMaps(before, after, intended = () => false) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((k) => {
    const oldData = before.get(k), newData = after.get(k);
    if (oldData && newData && oldData.equals(newData)) return null;
    const [type, id, language] = k.split(':').map(Number);
    return { type, id, language, change: !oldData ? 'added' : !newData ? 'removed' : 'replaced', oldSha256: oldData ? sha256(oldData) : null, newSha256: newData ? sha256(newData) : null, classification: intended(k) ? 'expected' : 'unexpected' };
  }).filter(Boolean);
}

export function validatePe(input, expectedMachine, expectedVersion = null) {
  const exe = PE.NtExecutable.from(input);
  if (exe.newHeader.fileHeader.machine !== Number(expectedMachine)) throw new Error(`PE machine mismatch: 0x${exe.newHeader.fileHeader.machine.toString(16)}`);
  const resources = PE.NtExecutableResource.from(exe); assertResourceKeys(resources.entries); assertIconIntegrity(resources.entries);
  if (expectedVersion) {
    const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
    const values = versions.map((v) => `${v.fixedInfo.fileVersionMS >>> 16}.${String(v.fixedInfo.fileVersionMS & 0xffff).padStart(2, '0')}`);
    if (!versions.length || !values.some((value) => value === expectedVersion)) throw new Error(`PE version ${values.join(', ')} does not include ${expectedVersion}`);
  }
  return { machine: `0x${exe.newHeader.fileHeader.machine.toString(16).padStart(4, '0')}`, resourceCount: resources.entries.length, hasAuthenticode: exe.newHeader.optionalHeaderDataDirectory.get(4).size > 0 };
}
