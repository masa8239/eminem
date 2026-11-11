/**
 * BENCHCORE スプレッドシート自動メンテナンス（Google Apps Script）
 *
 * できること
 *  - 楽天市場から自動取得した価格を「価格(円)」列に書き込む
 *  - 価格が空・円でない値のセルを赤く塗る
 *  - 等級違い・系列違いなど機械的に直せるモデル名を正しい名前に書き換える（元の名前はメモに残す）
 *  - 直せないモデル名（存在しない型番など）のセルを黄色く塗り、理由をメモに書く
 *
 * 使い方（最初の1回だけ）
 *  1. スプレッドシートを開き、[拡張機能] → [Apps Script] を開く
 *  2. このファイルの中身を新しいスクリプトファイルに貼り付けて保存
 *  3. 関数「benchcorePreview」を実行 → [実行ログ] で何が変わるかを確認（シートは変更されません）
 *  4. 問題なければ「benchcoreSync」を実行（実際に書き込みます）
 *  5. 「benchcoreInstallDailyTrigger」を1回実行すると、毎朝自動で benchcoreSync が動きます
 *
 * 書き換えるのは「価格(円)」列の値、機械的に直せるモデル名、価格セル・モデル名セルの背景色とメモだけです。
 * スコアなど他の列、数式の入ったセルは書き換えません。行の削除もしません。
 * モデル名の自動修正を止めたい場合は BENCHCORE_FIX_NAMES を false にしてください。
 */

var BENCHCORE_DATA_URL = 'https://raw.githubusercontent.com/masa8239/eminem/main/data/';
var BENCHCORE_MAX_AGE_DAYS = 7;
var BENCHCORE_NAME_COLUMNS = {'CPU名': 'cpu', 'GPU名': 'gpu'};
var BENCHCORE_PRICE_COLUMN = '価格(円)';
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

    var rows = lastRow - 1;
    var nameRange = sheet.getRange(2, nameIndex + 1, rows, 1);
    var priceRange = sheet.getRange(2, priceIndex + 1, rows, 1);
    var names = nameRange.getValues(), nameBackgrounds = nameRange.getBackgrounds();
    var values = priceRange.getValues(), formulas = priceRange.getFormulas(), priceBackgrounds = priceRange.getBackgrounds();
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

      if (product && !formulas[i][0]) {
        if (current !== product.price) {
          log.push(sheet.getName() + ' / ' + name + ': 価格 ' + (current === '' ? '(空)' : current) + ' → ' + product.price);
          if (!dryRun) {
            priceCell.setValue(product.price);
            priceCell.setNote('楽天市場の価格を自動反映（' + Utilities.formatDate(new Date(product.fetchedAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') + ' 取得）。以前の値: ' + (current === '' ? '(空)' : current));
          }
        }
        if (!dryRun && priceBackgrounds[i][0] === BENCHCORE_COLOR_PRICE) priceCell.setBackground(null);
      } else if (!formulas[i][0]) {
        var ok = typeof current === 'number' && current >= 1000 && current % 1 === 0;
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
