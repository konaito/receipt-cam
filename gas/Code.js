// receipt-cam の受け口。カメラアプリから写真を受け取り、Drive のフォルダに保存する
// 送り先 URL は「ウェブアプリの URL?k=<キー>」。キーはスクリプトのプロパティ KEY にあり、setup() が作る
// 保存先はスクリプトのプロパティ FOLDER_ID。空なら setup() がマイドライブに receipts フォルダを作る
var VERSION = 2;
var DEFAULT_FOLDER_NAME = 'receipts';

// 疎通確認。キーが合えば保存先のフォルダ名を返す
function doGet(e) {
  return guard(e, function (folder) {
    return { ok: true, app: 'receipt-cam', version: VERSION, folder: { name: folder.getName(), url: folder.getUrl() } };
  });
}

// 写真の保存。本文は JSON { id, takenAt, mime, data(base64) }
function doPost(e) {
  return guard(e, function (folder) {
    var body = JSON.parse(e.postData.contents);
    if (!/^[0-9a-f-]{36}$/.test(body.id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(body.takenAt)) {
      return { ok: false, error: 'bad request' };
    }
    // 20260930_041530_1a2b3c4d.jpg（撮影時刻は端末の時刻）
    var name = body.takenAt.slice(0, 19).replace(/-|:/g, '').replace('T', '_') + '_' + body.id.slice(0, 8) + '.jpg';
    var blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mime || 'image/jpeg', name);
    var lock = LockService.getScriptLock(); // 画面と service worker が同じ写真を同時に送っても1枚にする
    lock.waitLock(30000);
    try {
      var dup = folder.getFilesByName(name);
      if (dup.hasNext()) return { ok: true, fileId: dup.next().getId(), duplicate: true };
      var file = folder.createFile(blob);
      file.setDescription(JSON.stringify({ id: body.id, takenAt: body.takenAt, receivedAt: new Date().toISOString() }));
      return { ok: true, fileId: file.getId() };
    } finally {
      lock.releaseLock();
    }
  });
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
  Logger.log('保存先: ' + folder.getName() + ' ' + folder.getUrl());
  Logger.log('キー: ' + key);
  Logger.log('送り先 URL: デプロイした「ウェブアプリの URL」（/exec で終わる）の末尾に ?k=' + key + ' を付ける');
}

// キーを作り直す。今の送り先 URL は使えなくなる
function rotateKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  setup();
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
