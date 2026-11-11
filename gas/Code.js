// receipt-cam の受け口。カメラアプリから写真を受け取り、Drive のフォルダに保存する
// 送り先 URL は「ウェブアプリの URL?k=<キー>」。キーはスクリプトのプロパティ KEY にあり、setup() が作る
// 保存先の根はスクリプトのプロパティ FOLDER_ID。空なら setup() がマイドライブに receipts フォルダを作る
// アプリで足した保存先は、根の直下のサブフォルダになる。保存先を指定しない写真は根に入る
var VERSION = 3;
var DEFAULT_FOLDER_NAME = 'receipts';
var NAME_MAX = 40; // 保存先の名前の長さの上限。アプリの queue.js と同じ値
var APP_URL = 'https://konaito.github.io/receipt-cam/'; // カメラアプリ。自分の Pages に置いたらここを変える

// 疎通確認。キーが合えば根のフォルダと、その直下の保存先の一覧を返す
function doGet(e) {
  return guard(e, function (root) {
    return {
      ok: true, app: 'receipt-cam', version: VERSION,
      folder: { id: root.getId(), name: root.getName(), url: root.getUrl() },
      folders: listDests(root),
    };
  });
}

// 本文は JSON。action が無ければ写真の保存 { id, takenAt, mime, data(base64), dest?: { id?, name } }
// action: 'mkdir' { name }            保存先を作る。同じ名前があればそれを返す
// action: 'rename' { dest: { id }, name }  保存先の名前を変える
function doPost(e) {
  return guard(e, function (root) {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'mkdir') return withLock(function () { return mkdir(root, body.name); });
    if (body.action === 'rename') return withLock(function () { return rename(root, body.dest, body.name); });
    if (body.action) return { ok: false, error: 'bad action' };
    return savePhoto(root, body);
  });
}

function savePhoto(root, body) {
  if (!/^[0-9a-f-]{36}$/.test(body.id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(body.takenAt)) {
    return { ok: false, error: 'bad request' };
  }
  // 20260930_041530_1a2b3c4d.jpg（撮影時刻は端末の時刻）
  var name = body.takenAt.slice(0, 19).replace(/-|:/g, '').replace('T', '_') + '_' + body.id.slice(0, 8) + '.jpg';
  var blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mime || 'image/jpeg', name);
  // 画面と service worker が同じ写真を同時に送っても1枚にする。保存先のフォルダ作りも同じロックの中で行う
  return withLock(function () {
    var folder = resolveDest(root, body.dest);
    var dest = folder.getId() === root.getId() ? null : { id: folder.getId(), name: folder.getName() };
    var dup = folder.getFilesByName(name);
    if (dup.hasNext()) return { ok: true, fileId: dup.next().getId(), duplicate: true, dest: dest };
    var file = folder.createFile(blob);
    file.setDescription(JSON.stringify({ id: body.id, takenAt: body.takenAt, receivedAt: new Date().toISOString() }));
    return { ok: true, fileId: file.getId(), dest: dest };
  });
}

// 写真の保存先を決める。ID があれば根の直下のフォルダか確かめ、無いか外れたら名前で探し、無ければ作る
// 保存先が無い・名前が不正なら根に入れる（キューが詰まって写真が届かなくなるのを避ける）
function resolveDest(root, dest) {
  if (!dest) return root;
  if (dest.id) {
    var byId = childById(root, String(dest.id));
    if (byId) return byId;
  }
  if (nameError(dest.name)) return root;
  return findOrCreate(root, String(dest.name).trim());
}

function mkdir(root, raw) {
  var err = nameError(raw);
  if (err) return { ok: false, error: err };
  var f = findOrCreate(root, String(raw).trim());
  return { ok: true, dest: { id: f.getId(), name: f.getName(), url: f.getUrl() } };
}

function rename(root, dest, raw) {
  var err = nameError(raw);
  if (err) return { ok: false, error: err };
  var f = dest && dest.id ? childById(root, String(dest.id)) : null;
  if (!f) return { ok: false, error: 'no such folder' };
  var name = String(raw).trim();
  if (f.getName() !== name && findChild(root, name)) return { ok: false, error: 'exists' };
  f.setName(name);
  return { ok: true, dest: { id: f.getId(), name: f.getName(), url: f.getUrl() } };
}

// 保存先の名前の検証。アプリの queue.js の destNameError と同じ規則
function nameError(raw) {
  if (typeof raw !== 'string') return 'bad name';
  var name = raw.trim();
  if (!name) return 'empty name';
  if (name.length > NAME_MAX) return 'name too long';
  if (/[\/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') return 'bad name';
  return '';
}

function childById(root, id) {
  try {
    var f = DriveApp.getFolderById(id);
    if (f.isTrashed()) return null;
    var parents = f.getParents();
    while (parents.hasNext()) if (parents.next().getId() === root.getId()) return f;
  } catch (err) { /* 無い ID、見られない ID */ }
  return null;
}

function findChild(root, name) {
  var it = root.getFoldersByName(name);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

function findOrCreate(root, name) {
  return findChild(root, name) || root.createFolder(name);
}

function listDests(root) {
  var list = [];
  var it = root.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) list.push({ id: f.getId(), name: f.getName(), url: f.getUrl() });
  }
  return list.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function guard(e, fn) {
  try {
    var key = PropertiesService.getScriptProperties().getProperty('KEY');
    if (!key || key.length < 32) return out({ ok: false, error: 'no key: run setup()' });
    if (((e && e.parameter && e.parameter.k) || '') !== key) return out({ ok: false, error: 'bad key' });
    return out(fn(getFolder()));
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function getFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var folder = DriveApp.createFolder(DEFAULT_FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

// 最初に1回、エディタから実行する。Drive の権限を許可させ、キーと保存先のフォルダを用意する
// 実行ログに出る URL かキーを、カメラアプリの設定に入れる
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('KEY');
  if (!key || key.length < 32) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('KEY', key);
  }
  var folder = getFolder();
  console.log('保存先: ' + folder.getName() + ' ' + folder.getUrl());
  console.log('キー: ' + key);

  // デプロイ済みで /exec の URL が取れれば、そのまま開けるセットアップ用リンクを出す
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { /* 未デプロイ */ }
  var steps = ['次はカメラアプリで:'];
  if (/\/exec$/.test(url)) {
    var api = url + '?k=' + key;
    steps.push('1. スマホでこのリンクを開く（送り先 URL が入り、疎通確認まで進む）: ' + APP_URL + '#api=' + encodeURIComponent(api));
    steps.push('   リンクを使わないときは、設定画面の「送り先 URL」にこれを貼る: ' + api);
  } else {
    steps.push('0. まだなら「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、実行するユーザー「自分」、アクセスできるユーザー「全員」でデプロイする');
    steps.push('1. ' + APP_URL + ' を開き、設定画面の「送り先 URL」に「ウェブアプリの URL（/exec で終わる）?k=' + key + '」を入れる');
  }
  steps.push('2. 「疎通確認」を押し、4つ（URL の形・Apps Script に届く・キーが合う・Drive のフォルダ「' + folder.getName() + '」）が通るのを確かめる');
  steps.push('3. 「この送り先を使う」を押す');
  steps.push('4. ブラウザのメニューから「ホーム画面に追加」する');
  console.log(steps.join('\n'));
}

// キーを作り直す。今の送り先 URL は使えなくなる
function rotateKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  setup();
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
