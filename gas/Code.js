// receipt-cam の受け口。カメラアプリから写真を受け取り、Drive のフォルダに保存する
// 送り先 URL は「ウェブアプリの URL?k=<キー>」。キーはスクリプトのプロパティ KEY にあり、setup() が作る
// 保存先はスクリプトのプロパティ FOLDER_ID。空なら setup() がマイドライブに receipts フォルダを作る
var VERSION = 2;
var DEFAULT_FOLDER_NAME = 'receipts';
var APP_URL = 'https://konaito.github.io/receipt-cam/'; // カメラアプリ。自分の Pages に置いたらここを変える

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
