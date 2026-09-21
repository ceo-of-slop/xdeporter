'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, FILES, buildZip, readZip, validateFiles, normalizeFile, parseTrackedEntries, readTrackedBlobs } = require('./package.cjs');

test('Git object packaging ignores later path/index replacement and rejects symlink modes', t => {
  const scratch = path.join(ROOT, 'work');
  fs.mkdirSync(scratch, { recursive: true });
  const repository = fs.mkdtempSync(path.join(scratch, 'package-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(repository)), path.resolve(scratch));
    fs.rmSync(repository, { recursive: true, force: true });
  });
  const fixtureGit = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
  fixtureGit('init', '--quiet');
  fs.mkdirSync(path.join(repository, 'extension'));
  const file = path.join(repository, 'extension', 'source.txt');
  fs.writeFileSync(file, 'reviewed bytes\n');
  fixtureGit('add', 'extension/source.txt');
  const captured = parseTrackedEntries(fixtureGit('ls-files', '--stage', '-z', '--', 'extension'));
  fs.writeFileSync(file, 'replaced bytes\n');
  fixtureGit('add', 'extension/source.txt');
  assert.equal(readTrackedBlobs(captured, repository)['source.txt'].toString(), 'reviewed bytes\n');
  // Git can represent symlinks even when Windows does not grant symlink privileges.
  fixtureGit('update-index', '--cacheinfo', `120000,${captured[0].oid},extension/source.txt`);
  assert.throws(() => parseTrackedEntries(fixtureGit('ls-files', '--stage', '-z', '--', 'extension')), /non-regular/);
  assert.throws(() => parseTrackedEntries(`120000 blob ${captured[0].oid}\textension/source.txt\0`, true), /non-regular/);
});

test('archive bytes are deterministic independent of input order', () => {
  const files = { 'a.txt': Buffer.from('alpha'), 'dir/b.txt': Buffer.from('beta') };
  const first = buildZip(files);
  assert.deepEqual(first, buildZip({ 'dir/b.txt': files['dir/b.txt'], 'a.txt': files['a.txt'] }));
  const extracted = readZip(first);
  for (const name of Object.keys(files)) assert.deepEqual(extracted[name], files[name]);
});

test('Windows and Unix text checkouts produce identical archives without changing binary files', () => {
  const unix = normalizeFile('INSTALL.txt', Buffer.from('first\nsecond\n'));
  const windows = normalizeFile('INSTALL.txt', Buffer.from('first\r\nsecond\r\n'));
  assert.deepEqual(buildZip({ 'INSTALL.txt': unix }), buildZip({ 'INSTALL.txt': windows }));
  const binary = Buffer.from([0, 13, 10, 255]);
  assert.deepEqual(normalizeFile('icons/icon16.png', binary), binary);
});

test('ZIP rejects traversal, corruption, truncation, appended data and symlink attributes', () => {
  for (const name of ['../x', '/x', 'a/../x', 'a\\x', 'C:/x']) assert.throws(() => buildZip({ [name]: 'bad' }));
  const zip = buildZip({ 'a.txt': 'alpha' });
  const corrupted = Buffer.from(zip); corrupted[35] ^= 1;
  assert.throws(() => readZip(corrupted));
  assert.throws(() => readZip(zip.subarray(0, -1)));
  assert.throws(() => readZip(Buffer.concat([zip, Buffer.from('extra')])));
  const link = Buffer.from(zip); link.writeUInt32LE(0xa1ff0000, 40 + 38);
  assert.throws(() => readZip(link));
});

test('shipping policy requires complete local files, scoped permissions and isolated content scripts', () => {
  const files = Object.fromEntries(FILES.map(name => [name, fs.readFileSync(path.join(ROOT, 'extension', name))]));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  validateFiles(files, pkg.version);
  assert.throws(() => validateFiles({ ...files, 'secret.txt': Buffer.from('secret') }, pkg.version));
  const badManifest = JSON.parse(files['manifest.json']);
  badManifest.host_permissions.push('https://*/*');
  assert.throws(() => validateFiles({ ...files, 'manifest.json': Buffer.from(JSON.stringify(badManifest)) }));
  const wrongWorld = JSON.parse(files['manifest.json']); wrongWorld.content_scripts[0].world = 'MAIN';
  assert.throws(() => validateFiles({ ...files, 'manifest.json': Buffer.from(JSON.stringify(wrongWorld)) }));
  assert.throws(() => validateFiles({ ...files, 'popup.html': Buffer.from('<script src="https://bad.example/code.js"></script>') }));
  const extracted = readZip(buildZip(files));
  validateFiles(extracted, pkg.version);
  for (const name of FILES) assert.deepEqual(extracted[name], files[name]);
});
