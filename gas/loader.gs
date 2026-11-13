/** @OnlyCurrentDoc */
/**
 * BENCHCORE 読み込み用（シートに貼るのはこのファイルだけ）
 *
 * 実行のたびに GitHub の main ブランチから gas/sheet-sync.gs を読み込んで動かします。
 * GitHub 側を更新すれば、このシートは何もしなくても次の実行から新しいコードで動きます。
 * つまり、main ブランチにあるコードがこのシートの中で毎朝実行されます。
 * 読み込みに失敗したときは何もしません（シートは変更されません）。
 *
 * 使い方（最初の1回だけ）
 *  1. [拡張機能] → [Apps Script] で、以前貼った benchcore のファイルの中身をこのファイルの中身に置き換えて保存
 *  2. 「benchcorePreview」を実行 → [実行ログ] で内容を確認（シートは変更されません）
 *  3. 「benchcoreInstallDailyTrigger」を1回実行（毎朝5時台に benchcoreSync が自動で動きます）
 */

var BENCHCORE_CODE_URL = 'https://raw.githubusercontent.com/masa8239/eminem/main/gas/sheet-sync.gs';

function benchcoreLoad_() {
  var response = UrlFetchApp.fetch(BENCHCORE_CODE_URL, {muteHttpExceptions: true});
  if (response.getResponseCode() !== 200) throw new Error('GitHub からコードを読み込めませんでした (HTTP ' + response.getResponseCode() + ')');
  var code = response.getContentText();
  if (code.indexOf('function benchcoreRun_') < 0) throw new Error('読み込んだコードの形が想定と違うため、実行を中止しました');
  // 読み込んだコードは関数の中だけで動かす（このプロジェクトの他のコードとは名前がぶつからない）
  return new Function(code + '\nreturn {run: benchcoreRun_};')();
}

function benchcorePreview() { benchcoreLoad_().run(true); }
function benchcoreSync() { benchcoreLoad_().run(false); }

function benchcoreInstallDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'benchcoreSync') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('benchcoreSync').timeBased().everyDays(1).atHour(5).create();
  Logger.log('毎日5時台に benchcoreSync を実行するよう設定しました');
}
