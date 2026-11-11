// gas/Code.js の doGet と doPost を、Drive などの最小のスタブで node から呼んで確かめる
// 実行: node tools/gas_mock_test.js
// スタブは Code.js が使う範囲だけを真似る。実際の Drive の挙動（ゴミ箱、権限など）はこれでは確かめられない
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeEnv() {
  let seq = 0;
  const folders = new Map();
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  class Folder {
    constructor(name, parent) {
      this.id = 'f' + (++seq); this.name = name; this.parent = parent; this.trashed = false; this.files = [];
      folders.set(this.id, this);
    }
    getId() { return this.id; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; }
    isTrashed() { return this.trashed; }
    getParents() { return iter(this.parent ? [this.parent] : []); }
    children() { return [...folders.values()].filter((f) => f.parent === this); }
    getFolders() { return iter(this.children()); }
    getFoldersByName(n) { return iter(this.children().filter((f) => f.name === n)); }
    createFolder(n) { return new Folder(n, this); }
    getFilesByName(n) { return iter(this.files.filter((f) => f.name === n)); }
    createFile(blob) {
      const f = { id: 'file' + (++seq), name: blob.name, getId() { return this.id; }, setDescription(d) { this.desc = d; } };
      this.files.push(f);
      return f;
    }
  }
  const props = new Map([['KEY', 'k'.repeat(32)]]);
  let locks = 0;
  const ctx = {
    console,
    DriveApp: {
      getFolderById(id) { const f = folders.get(id); if (!f) throw new Error('No item with the given ID'); return f; },
      createFolder(n) { return new Folder(n, null); },
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v), deleteProperty: (k) => props.delete(k),
    }) },
    LockService: { getScriptLock: () => ({ waitLock() { locks++; }, releaseLock() { locks--; } }) },
    Utilities: { newBlob: (data, mime, name) => ({ data, mime, name }), base64Decode: (s) => Buffer.from(s, 'base64'), getUuid: () => 'u' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
    ScriptApp: { getService: () => ({ getUrl: () => '' }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.js'), 'utf8'), ctx);
  const root = ctx.DriveApp.createFolder('receipts');
  props.set('FOLDER_ID', root.id);
  const key = { k: 'k'.repeat(32) };
  return {
    root, locks: () => locks,
    createTopFolder: (name) => new Folder(name, null),
    get: (p = key) => ctx.doGet({ parameter: p }),
    post: (body, p = key) => ctx.doPost({ parameter: p, postData: { contents: JSON.stringify(body) } }),
  };
}

let n = 0;
const photo = (extra = {}) => ({ id: String(10000000 + n++) + '-0000-4000-8000-000000000000', takenAt: '2026-11-11T12:34:56+09:00', mime: 'image/jpeg', data: 'AAAA', ...extra });
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('疎通確認: 根と保存先の一覧を返し、旧アプリが読む app と folder の形は変えない', () => {
  const env = makeEnv();
  env.root.createFolder('名刺');
  const b = env.get();
  assert.equal(b.ok, true); assert.equal(b.app, 'receipt-cam'); assert.equal(b.version, 3);
  assert.equal(b.folder.name, 'receipts'); assert.ok(b.folder.url);
  assert.deepEqual(b.folders.map((f) => f.name), ['名刺']);
});

test('キーが違えば bad key', () => {
  const env = makeEnv();
  assert.equal(env.get({ k: 'x' }).error, 'bad key');
  assert.equal(env.post(photo(), { k: 'x' }).error, 'bad key');
});

test('旧本文（保存先なし）は根に保存し、dest は null', () => {
  const env = makeEnv();
  const b = env.post(photo({ id: '1a2b3c4d-0000-4000-8000-000000000000' }));
  assert.equal(b.ok, true); assert.equal(b.dest, null);
  assert.equal(env.root.files.length, 1);
  assert.equal(env.root.files[0].name, '20261111_123456_1a2b3c4d.jpg');
});

test('保存先の名前だけ（オフラインで足した保存先）: 無ければ作って入れ、2枚目は同じフォルダに入れる', () => {
  const env = makeEnv();
  const a = env.post(photo({ dest: { name: ' 名刺 ' } }));
  const b = env.post(photo({ dest: { name: '名刺' } }));
  assert.equal(a.ok && b.ok, true);
  assert.equal(env.root.children().length, 1);
  assert.equal(a.dest.name, '名刺'); assert.equal(a.dest.id, b.dest.id);
  assert.equal(env.root.children()[0].files.length, 2);
  assert.equal(env.root.files.length, 0);
});

test('保存先の ID: 名前を変えたあとの古い名前でも、ID が合えばそのフォルダに入れる', () => {
  const env = makeEnv();
  const f = env.post({ action: 'mkdir', name: '経費' }).dest;
  assert.equal(env.post({ action: 'rename', dest: { id: f.id }, name: '経費2026' }).ok, true);
  const b = env.post(photo({ dest: { id: f.id, name: '経費' } }));
  assert.equal(b.dest.id, f.id); assert.equal(b.dest.name, '経費2026');
  assert.equal(env.root.children().length, 1);
});

test('根の外のフォルダの ID は使わず、名前で根の直下に入れる', () => {
  const env = makeEnv();
  const x = env.createTopFolder('よそ'); // マイドライブ直下の、根とは別のフォルダ
  const b = env.post(photo({ dest: { id: x.id, name: 'よそ' } }));
  assert.notEqual(b.dest.id, x.id);
  assert.equal(x.files.length, 0);
  assert.equal(env.root.children()[0].name, 'よそ');
});

test('ゴミ箱のフォルダは使わない（スタブの isTrashed で確かめる）', () => {
  const env = makeEnv();
  const f = env.root.createFolder('名刺');
  f.trashed = true;
  const b = env.post(photo({ dest: { id: f.id, name: '名刺' } }));
  assert.notEqual(b.dest.id, f.id);
  assert.equal(f.files.length, 0);
  assert.deepEqual(env.get().folders.map((x) => x.id), [b.dest.id]);
});

test('写真の保存先の名前が不正なら根に入れる（キューを詰まらせない）', () => {
  const env = makeEnv();
  for (const name of ['', '  ', 'a/b', 'a\\b', '..', 'x'.repeat(41), 123]) {
    const b = env.post(photo({ dest: { name } }));
    assert.equal(b.ok, true, JSON.stringify(name)); assert.equal(b.dest, null);
  }
  assert.equal(env.root.children().length, 0);
});

test('mkdir: 不正な名前は理由を返す。同じ名前は作り直さない', () => {
  const env = makeEnv();
  assert.equal(env.post({ action: 'mkdir', name: '' }).error, 'empty name');
  assert.equal(env.post({ action: 'mkdir', name: 'a/b' }).error, 'bad name');
  assert.equal(env.post({ action: 'mkdir', name: 'x'.repeat(41) }).error, 'name too long');
  assert.equal(env.post({ action: 'mkdir', name: 'x'.repeat(40) }).ok, true);
  const a = env.post({ action: 'mkdir', name: '名刺' });
  const b = env.post({ action: 'mkdir', name: '名刺' });
  assert.equal(a.dest.id, b.dest.id);
  assert.equal(env.root.children().length, 2);
});

test('rename: 同じ名前の保存先があれば断る。根の外の ID は断る', () => {
  const env = makeEnv();
  const a = env.post({ action: 'mkdir', name: 'A' }).dest;
  env.post({ action: 'mkdir', name: 'B' });
  assert.equal(env.post({ action: 'rename', dest: { id: a.id }, name: 'B' }).error, 'exists');
  assert.equal(env.post({ action: 'rename', dest: { id: env.root.id }, name: 'C' }).error, 'no such folder');
  assert.equal(env.post({ action: 'rename', dest: { id: a.id }, name: 'A' }).ok, true);
});

test('同じ写真を2回送っても1枚（保存先付きでも）', () => {
  const env = makeEnv();
  const p = photo({ dest: { name: '名刺' } });
  env.post(p);
  const b = env.post(p);
  assert.equal(b.duplicate, true);
  assert.equal(env.root.children()[0].files.length, 1);
  assert.equal(env.locks(), 0);
});

test('知らない action と壊れた写真の本文は断る', () => {
  const env = makeEnv();
  assert.equal(env.post({ action: 'rm' }).error, 'bad action');
  assert.equal(env.post({ id: 'x', takenAt: 'y' }).error, 'bad request');
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
console.log(`${cases.length - failed}/${cases.length} 通った`);
process.exit(failed ? 1 : 0);
