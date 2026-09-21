'use strict';
// Dependency-free, reproducible ZIP writer. Only this explicit, tracked file set ships.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const FILES = Object.freeze([
  'INSTALL.txt', 'LICENSE.txt', 'background.js', 'content.css', 'content.js', 'core.js',
  'icons/icon.svg', 'icons/icon128.png', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png',
  'manifest.json', 'popup.css', 'popup.html', 'popup.js', 'provider.js'
].sort());
const HOSTS = ['https://x.com/*', 'https://www.x.com/*', 'https://twitter.com/*', 'https://www.twitter.com/*'].sort();
const safeName = name => typeof name === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) && !name.split('/').some(part => part === '.' || part === '..');
const fail = message => { throw new Error(message); };
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const names = Object.keys(files).sort();
  if (names.length > 65535) fail('Too many files');
  const local = [], central = [];
  let offset = 0;
  for (const name of names) {
    if (!safeName(name)) fail(`Unsafe ZIP name: ${name}`);
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(files[name]);
    const checksum = crc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12); // 1980-01-01; no filesystem timestamps.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function readZip(zip) {
  if (zip.length < 22 || zip.length > 10 * 1024 * 1024) fail('Invalid archive size');
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 20)) fail('Invalid ZIP end');
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralStart = zip.readUInt32LE(end + 16);
  if (count !== zip.readUInt16LE(end + 8) || centralStart + centralSize !== end) fail('Invalid ZIP directory');
  const files = Object.create(null);
  let cursor = centralStart, offset = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid central entry');
    const nameSize = zip.readUInt16LE(cursor + 28);
    const size = zip.readUInt32LE(cursor + 24);
    const checksum = zip.readUInt32LE(cursor + 16);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    if (!safeName(name) || Object.hasOwn(files, name) || Buffer.byteLength(name) !== nameSize) fail('Unsafe or duplicate ZIP name');
    if (zip.readUInt16LE(cursor + 8) || zip.readUInt16LE(cursor + 10) || zip.readUInt16LE(cursor + 30) || zip.readUInt16LE(cursor + 32) || zip.readUInt16LE(cursor + 34) || zip.readUInt32LE(cursor + 38)) fail('Unsupported ZIP attributes');
    if (zip.readUInt32LE(cursor + 20) !== size || zip.readUInt32LE(cursor + 42) !== offset) fail('Invalid ZIP offsets or sizes');
    if (offset + 30 + nameSize + size > centralStart || zip.readUInt32LE(offset) !== 0x04034b50) fail('Invalid local entry');
    if (zip.readUInt16LE(offset + 6) || zip.readUInt16LE(offset + 8) || zip.readUInt16LE(offset + 28) || zip.readUInt16LE(offset + 26) !== nameSize) fail('Invalid local attributes');
    if (zip.readUInt32LE(offset + 14) !== checksum || zip.readUInt32LE(offset + 18) !== size || zip.readUInt32LE(offset + 22) !== size) fail('Local and central metadata differ');
    if (zip.subarray(offset + 30, offset + 30 + nameSize).toString('utf8') !== name) fail('Local and central names differ');
    const body = zip.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size);
    if (crc32(body) !== checksum) fail('ZIP checksum mismatch');
    files[name] = body;
    offset += 30 + nameSize + size;
    cursor += 46 + nameSize;
  }
  if (cursor !== end || offset !== centralStart) fail('Unexpected ZIP data');
  return files;
}

function validateFiles(files, version) {
  assert.deepEqual(Object.keys(files).sort(), FILES, 'Package must contain exactly the approved file set');
  const manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  if (version) assert.equal(manifest.version, version, 'Manifest and package versions differ');
  assert.deepEqual([...manifest.permissions].sort(), ['storage', 'webRequest']);
  assert.deepEqual([...manifest.host_permissions].sort(), HOSTS);
  for (const key of ['externally_connectable', 'web_accessible_resources', 'update_url', 'sandbox', 'optional_permissions', 'optional_host_permissions', 'devtools_page']) {
    if (Object.hasOwn(manifest, key)) fail(`Unexpected manifest capability: ${key}`);
  }
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.content_scripts.length, 1);
  const script = manifest.content_scripts[0];
  assert.deepEqual([...script.matches].sort(), HOSTS);
  assert.equal(script.world || 'ISOLATED', 'ISOLATED');
  assert.equal(Boolean(script.all_frames), false);
  assert.deepEqual(script.js, ['core.js', 'content.js']);
  assert.deepEqual(script.css, ['content.css']);
  const references = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), ...script.js, ...script.css];
  for (const match of files['popup.html'].toString('utf8').matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) references.push(match[1]);
  for (const name of references) if (!safeName(name) || !Object.hasOwn(files, name)) fail(`Missing or non-local resource: ${name}`);
  return manifest;
}

function normalizeFile(name, bytes) {
  return name.endsWith('.png') ? bytes : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function parseTrackedEntries(listing, release = false) {
  return listing.split('\0').filter(Boolean).map(entry => {
    const match = release
      ? /^(\d{6}) (blob) ([a-f0-9]{40,64})\t(extension\/.+)$/.exec(entry)
      : /^(\d{6}) ([a-f0-9]{40,64}) (0)\t(extension\/.+)$/.exec(entry);
    if (!match || match[1] !== '100644') fail('Refusing non-regular or conflicted Git entry');
    const name = match[4].slice('extension/'.length);
    if (!safeName(name)) fail('Unsafe tracked filename');
    return { name, oid: match[release ? 3 : 2] };
  });
}

function readTrackedBlobs(entries, repository = ROOT) {
  const files = Object.create(null);
  for (const { name, oid } of entries) {
    // Read the captured immutable object ID, never a checked filesystem path or
    // a mutable index/ref. Symlink modes were rejected before reaching this step.
    const bytes = execFileSync('git', ['cat-file', 'blob', oid], { cwd: repository, windowsHide: true });
    files[name] = normalizeFile(name, bytes);
  }
  return files;
}

function loadSource(release = false, revision = release ? git('rev-parse', 'HEAD') : null) {
  const listing = release
    ? git('ls-tree', '-r', '-z', revision, '--', 'extension')
    : git('ls-files', '--stage', '-z', '--', 'extension');
  const entries = parseTrackedEntries(listing, release);
  assert.deepEqual(entries.map(entry => entry.name).sort(), FILES, 'Tracked extension files must match the shipping allowlist');
  const found = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) fail(`Refusing symlink: ${name}`);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), `${name}/`);
      else if (entry.isFile()) found.push(name);
      else fail(`Refusing non-regular file: ${name}`);
    }
  }
  walk(path.join(ROOT, 'extension'));
  assert.deepEqual(found.sort(), FILES, 'Extension directory contains unexpected or missing files');
  return readTrackedBlobs(entries);
}

function packageExtension(release = false) {
  const revision = release ? git('rev-parse', 'HEAD') : null;
  const files = loadSource(release, revision);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = validateFiles(files, pkg.version);
  if (release) {
    if (git('status', '--porcelain', '--untracked-files=all')) fail('Release requires a clean working tree');
    const expected = `v${manifest.version}`;
    if (process.env.GITHUB_REF && process.env.GITHUB_REF !== `refs/tags/${expected}`) fail('Workflow tag and manifest version differ');
    assert.equal(git('rev-parse', 'HEAD'), revision, 'Release commit changed during packaging');
    assert.equal(git('rev-parse', `refs/tags/${expected}^{commit}`), revision, 'Release tag must point to the packaged commit');
  }
  const zip = buildZip(files);
  const extracted = readZip(zip);
  validateFiles(extracted, pkg.version);
  for (const name of FILES) assert.deepEqual(extracted[name], files[name], `Archive differs from source: ${name}`);
  const digest = crypto.createHash('sha256').update(zip).digest('hex');
  const name = `xdeporter-v${manifest.version}.zip`;
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, name), zip);
  fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${digest}  ${name}\n`);
  console.log(`${path.join(dist, name)}\nSHA256 ${digest}`);
  return { zip, digest, files };
}

module.exports = { FILES, ROOT, buildZip, readZip, validateFiles, normalizeFile, parseTrackedEntries, readTrackedBlobs, loadSource, packageExtension };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--release')) fail('Usage: node scripts/package.cjs [--release]');
    packageExtension(args.includes('--release'));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
