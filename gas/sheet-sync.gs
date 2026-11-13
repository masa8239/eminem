/**
 * BENCHCORE スプレッドシート自動メンテナンス（Google Apps Script）
 *
 * このファイルは GitHub（masa8239/eminem の gas/sheet-sync.gs）で管理しています。
 * シートには gas/loader.gs だけを貼り付け、毎回ここから最新のコードを読み込んで動かします。
 *
 * できること
 *  - ストア（楽天市場・Yahoo!ショッピング）から自動取得した最安値を「最安値(円)」列に書き込む
 *    （「価格(円)」は人が入れる基準の価格なので書き換えない。自動取得の基準がずれていかないようにするため）
 *  - 価格(円) が空・円でない値で、最安値も取れていない行の価格セルを赤く塗る
 *  - 等級違い・系列違いなど機械的に直せるモデル名を正しい名前に書き換える（元の名前はメモに残す）
 *  - 直せないモデル名（存在しない型番など）のセルを黄色く塗り、理由をメモに書く
 *
 * 書き換えるのは「最安値(円)」列、機械的に直せるモデル名、価格セル・モデル名セルの背景色とメモだけです。
 * スコアや価格(円)など他の列、数式の入ったセルは書き換えません。行の削除もしません。
 * モデル名の自動修正を止めたい場合は BENCHCORE_FIX_NAMES を false にしてください。
 */

var BENCHCORE_DATA_URL = 'https://raw.githubusercontent.com/masa8239/eminem/main/data/';
var BENCHCORE_MAX_AGE_DAYS = 7;
var BENCHCORE_NAME_COLUMNS = {'CPU名': 'cpu', 'GPU名': 'gpu'};
var BENCHCORE_PRICE_COLUMN = '価格(円)';
var BENCHCORE_BEST_COLUMN = '最安値(円)';
var BENCHCORE_COLOR_PRICE = '#f4cccc';
var BENCHCORE_COLOR_NAME = '#fff2cc';
var BENCHCORE_FIX_NAMES = true;

function benchcorePreview() { benchcoreRun_(true); }
function benchcoreSync() { benchcoreRun_(false); }

function benchcoreInstallDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'benchcoreSync') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('benchcoreSync').timeBased().everyDays(1).atHour(5).create();
  Logger.log('毎日5時台に benchcoreSync を実行するよう設定しました');
}

function benchcoreFetch_(file) {
  var response = UrlFetchApp.fetch(BENCHCORE_DATA_URL + file, {muteHttpExceptions: true});
  if (response.getResponseCode() !== 200) throw new Error(file + ' を取得できませんでした (HTTP ' + response.getResponseCode() + ')');
  return JSON.parse(response.getContentText());
}

function benchcoreRun_(dryRun) {
  var priceData = benchcoreFetch_('rakuten-prices.json');
  var auditData = benchcoreFetch_('sheet-audit.json');
  var now = new Date().getTime();
  var prices = {};
  (priceData.products || []).forEach(function (product) {
    var age = now - new Date(product.fetchedAt).getTime();
    var valid = product.status === 'ok' && typeof product.price === 'number' && product.price >= 1000 && product.price % 1 === 0;
    if (valid && age >= 0 && age < BENCHCORE_MAX_AGE_DAYS * 86400000) prices[product.category + '|' + product.modelName] = product;
  });
  // 内蔵グラフィックスや Apple M シリーズなど、単体で売っていない製品（価格が入らないのが正常）
  var unpriceable = {};
  (priceData.unmatched || []).forEach(function (item) {
    if (item.reason === '型番を判定できないモデル名') unpriceable[item.category + '|' + item.modelName] = true;
  });
  var nameIssues = {}, nameFixes = {};
  (auditData.issues || []).forEach(function (issue) {
    var issueKey = issue.category + '|' + issue.modelName;
    if (issue.type === 'name') { nameIssues[issueKey] = issue.issue; if (issue.fix) nameFixes[issueKey] = issue.fix; }
    if (issue.type === 'duplicate' && !nameIssues[issueKey]) nameIssues[issueKey] = issue.issue;
  });

  var log = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sheet) {
    var lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) return;
    var header = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (value) { return String(value).trim(); });
    var nameIndex = -1, category = null;
    Object.keys(BENCHCORE_NAME_COLUMNS).forEach(function (column) {
      if (nameIndex < 0 && header.indexOf(column) >= 0) { nameIndex = header.indexOf(column); category = BENCHCORE_NAME_COLUMNS[column]; }
    });
    var priceIndex = header.indexOf(BENCHCORE_PRICE_COLUMN);
    if (nameIndex < 0 || priceIndex < 0) return;
    // 最安値の列がなければ右端に作る（プレビューでは作らない）
    var bestIndex = header.indexOf(BENCHCORE_BEST_COLUMN);
    if (bestIndex < 0 && !dryRun) {
      bestIndex = lastColumn;
      sheet.getRange(1, bestIndex + 1).setValue(BENCHCORE_BEST_COLUMN)
        .setNote('ストアから自動取得した最安値です。毎朝自動で更新されます。手で書き換えないでください。');
    }

    var rows = lastRow - 1;
    var nameRange = sheet.getRange(2, nameIndex + 1, rows, 1);
    var priceRange = sheet.getRange(2, priceIndex + 1, rows, 1);
    var names = nameRange.getValues(), nameBackgrounds = nameRange.getBackgrounds();
    var values = priceRange.getValues(), formulas = priceRange.getFormulas(), priceBackgrounds = priceRange.getBackgrounds();
    var bestRange = bestIndex >= 0 ? sheet.getRange(2, bestIndex + 1, rows, 1) : null;
    var bestValues = bestRange ? bestRange.getValues() : names.map(function () { return ['']; });
    var nameFormulas = nameRange.getFormulas();
    var existing = {};
    names.forEach(function (row) { var n = String(row[0]).trim(); if (n) existing[n] = (existing[n] || 0) + 1; });

    for (var i = 0; i < rows; i++) {
      var name = String(names[i][0]).trim();
      if (!name) continue;
      var key = category + '|' + name;
      var nameCell = nameRange.getCell(i + 1, 1), priceCell = priceRange.getCell(i + 1, 1);
      var current = values[i][0];
      var product = prices[key];

      // 最安値(円): 取れた価格を書く。取れなかった行は空にする（古い値を最新に見せない）
      var best = product ? product.price : '';
      if (bestValues[i][0] !== best) {
        if (product) log.push(sheet.getName() + ' / ' + name + ': 最安値 ' + (bestValues[i][0] === '' ? '(空)' : bestValues[i][0]) + ' → ' + best);
        if (!dryRun && bestRange) {
          var bestCell = bestRange.getCell(i + 1, 1);
          bestCell.setValue(best);
          if (product) bestCell.setNote((product.source || 'ストア') + '（' + Utilities.formatDate(new Date(product.fetchedAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') + ' 取得）');
          else bestCell.clearNote();
        }
      }

      // 価格(円): 人が入れる基準の価格。空・不正で、最安値も取れていない行だけ赤くする
      if (!formulas[i][0]) {
        var ok = (typeof current === 'number' && current >= 1000 && current % 1 === 0) || Boolean(product) || Boolean(unpriceable[key]);
        if (!ok && priceBackgrounds[i][0] !== BENCHCORE_COLOR_PRICE) {
          log.push(sheet.getName() + ' / ' + name + ': 価格を確認（現在の値: ' + (current === '' ? '(空)' : current) + '）');
          if (!dryRun) {
            priceCell.setBackground(BENCHCORE_COLOR_PRICE);
            priceCell.setNote('価格を確認してください。円の整数（例: 98000）で入力します。');
          }
        }
        if (ok && !dryRun && priceBackgrounds[i][0] === BENCHCORE_COLOR_PRICE) { priceCell.setBackground(null); priceCell.clearNote(); }
      }

      var issue = nameIssues[key];
      var fix = nameFixes[key];
      // 機械的に直せる名前は書き換える。直した結果が既存の行と重複する場合は書き換えず、要確認にする
      if (BENCHCORE_FIX_NAMES && fix && !nameFormulas[i][0] && !existing[fix]) {
        log.push(sheet.getName() + ' / モデル名を修正: ' + name + ' → ' + fix);
        if (!dryRun) {
          nameCell.setValue(fix);
          nameCell.setNote('モデル名を自動修正しました。以前の名前: ' + name);
          if (nameBackgrounds[i][0] === BENCHCORE_COLOR_NAME) nameCell.setBackground(null);
        }
        existing[fix] = 1;
        existing[name] = (existing[name] || 1) - 1;
        continue;
      }
      if (fix && existing[fix]) issue = '「' + fix + '」の書き間違いの可能性がありますが、同じ名前の行がすでにあります';
      if (issue && nameBackgrounds[i][0] !== BENCHCORE_COLOR_NAME) {
        log.push(sheet.getName() + ' / ' + name + ': モデル名を確認（' + issue + '）');
        if (!dryRun) { nameCell.setBackground(BENCHCORE_COLOR_NAME); nameCell.setNote('モデル名を確認してください: ' + issue); }
      }
      if (!issue && !dryRun && nameBackgrounds[i][0] === BENCHCORE_COLOR_NAME) { nameCell.setBackground(null); nameCell.clearNote(); }
    }
  });

  Logger.log((dryRun ? '【プレビュー：シートは変更していません】' : '【反映しました】') + ' ' + log.length + ' 件');
  log.forEach(function (line) { Logger.log(line); });
}
