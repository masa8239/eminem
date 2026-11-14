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
 *  - 単体のパーツとして売っていない製品（CPU内蔵グラフィックス、Apple M シリーズ）の行を削除する
 *  - ストアで見つかった新製品の行を末尾に追加する（スコアは空欄・黄色。スコアを入れるとサイトに載る）
 *  - GPUのシートがあるスプレッドシートに、メモリ・SSD・電源・マザーボードの最安値の一覧（「パーツ最安値」タブ）を書き出す。
 *    間違った商品は「除外する」にチェック、メーカーの判定違いは「正しいメーカー」に書くと、「パーツの修正」タブに保存され、
 *    翌朝の価格取得から反映される（「パーツの修正」タブは手で編集してもよい。チェックを外せば元に戻る）
 *
 * 書き換えるのは「最安値(円)」列、機械的に直せるモデル名、価格セル・モデル名セルの背景色とメモだけです。
 * スコアや価格(円)など他の列、数式の入ったセルは書き換えません。
 * 行を削除するのは、下の BENCHCORE_NOT_STANDALONE に当てはまる行だけです（止めたい場合は空の配列にする）。
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
var BENCHCORE_ADD_NEW = true;
var BENCHCORE_SCORE_COLUMNS = {cpu: 'PassMarkスコア', gpu: '3DMark Time Spy'};
var BENCHCORE_SCORE_SITE = {cpu: 'PassMark', gpu: '3DMark Time Spy'};
// 単体のパーツとして売っていない製品。シートから行ごと削除する
var BENCHCORE_PARTS_SHEET = 'パーツ最安値';
var BENCHCORE_FIX_SHEET = 'パーツの修正';
var BENCHCORE_PART_KINDS = {ram: 'メモリ', ssd: 'SSD', psu: '電源', mb: 'マザーボード'};
var BENCHCORE_PARTS_HEADER = ['種類', '規格', 'メーカー', '最安値(円)', '店', '商品名', '商品コード', '取得日時', '除外する', '正しいメーカー'];
var BENCHCORE_FIX_HEADER = ['商品コード', '種類', '商品名', '除外する', '正しいメーカー', '登録日', 'メモ'];
var BENCHCORE_NOT_STANDALONE = {
  cpu: [/^Apple M\d/i],
  gpu: [/^Radeon \d{3}M\b/i, /^Radeon RX Vega \d+\s*\(Ryzen/i, /^Intel (UHD |Iris )?Graphics/i, /^Radeon Graphics/i],
};

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
  // 新製品の候補（取得できなくても他の処理は続ける）
  var newData = {candidates: []};
  var newDataMissing = false;
  try { newData = benchcoreFetch_('new-products.json'); } catch (e) { newDataMissing = true; }
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
  var nameIssues = {}, nameFixes = {}, specIssues = {};
  (auditData.issues || []).forEach(function (issue) {
    var issueKey = issue.category + '|' + issue.modelName;
    if (issue.type === 'name') { nameIssues[issueKey] = issue.issue; if (issue.fix) nameFixes[issueKey] = issue.fix; }
    if (issue.type === 'duplicate' && !nameIssues[issueKey]) nameIssues[issueKey] = issue.issue;
    // 仕様（コア数・クロック・VRAM など）が出典の照合表と違う行。名前の指摘がない行だけ、同じ黄色で知らせる
    if (issue.type === 'spec') specIssues[issueKey] = issue.issue;
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

    // 単体で売っていない製品の行を、下から順に削除する（プレビューでは削除予定を表示するだけ）
    var patterns = BENCHCORE_NOT_STANDALONE[category] || [];
    var allNames = sheet.getRange(2, nameIndex + 1, lastRow - 1, 1).getValues();
    var skip = {};
    for (var d = allNames.length - 1; d >= 0; d--) {
      var n = String(allNames[d][0]).trim();
      if (!n || !patterns.some(function (p) { return p.test(n); })) continue;
      log.push(sheet.getName() + ' / ' + n + ': 単体で売っていない製品のため行を削除' + (dryRun ? '（予定）' : ''));
      if (dryRun) skip[d] = true; else sheet.deleteRow(d + 2);
    }
    if (!dryRun) lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

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
      if (!name || skip[i]) continue;
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
      var note = issue ? 'モデル名を確認してください: ' + issue : specIssues[key] ? specIssues[key] + '\n（AMD公式の仕様一覧 / Wikipedia の各世代の表と照合）' : '';
      if (!issue && specIssues[key]) issue = specIssues[key];
      if (issue && nameBackgrounds[i][0] !== BENCHCORE_COLOR_NAME) {
        log.push(sheet.getName() + ' / ' + name + ': ' + (note.indexOf('モデル名') === 0 ? 'モデル名を確認（' + issue + '）' : '仕様を確認（' + issue + '）'));
        if (!dryRun) { nameCell.setBackground(BENCHCORE_COLOR_NAME); nameCell.setNote(note); }
      }
      if (!issue && !dryRun && nameBackgrounds[i][0] === BENCHCORE_COLOR_NAME) { nameCell.setBackground(null); nameCell.clearNote(); }
    }

    // 新製品の行を末尾に追加する。同じ名前の行がすでにあれば何もしない（毎日重複して増えない）
    var scoreIndex = header.indexOf(BENCHCORE_SCORE_COLUMNS[category]);
    if (!BENCHCORE_ADD_NEW || scoreIndex < 0) return;
    var have = {};
    sheet.getRange(2, nameIndex + 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().forEach(function (row) {
      have[String(row[0]).trim().toUpperCase().replace(/\s+/g, ' ')] = true;
    });
    (newData.candidates || []).forEach(function (c) {
      if (c.category !== category || typeof c.modelName !== 'string' || !c.modelName.trim()) return;
      var name = c.modelName.trim();
      if (have[name.toUpperCase().replace(/\s+/g, ' ')]) return;
      if ((BENCHCORE_NOT_STANDALONE[category] || []).some(function (p) { return p.test(name); })) return;
      have[name.toUpperCase().replace(/\s+/g, ' ')] = true;
      log.push(sheet.getName() + ' / ' + name + ': 新製品として行を追加' + (dryRun ? '（予定）' : '') + '（出品 ' + c.listings + ' 件、相場 約' + c.medianPrice + '円）');
      if (dryRun) return;
      var width = Math.max(sheet.getLastColumn(), scoreIndex + 1, nameIndex + 1);
      var row = [];
      for (var k = 0; k < width; k++) row.push('');
      row[nameIndex] = name;
      sheet.appendRow(row);
      var at = sheet.getLastRow();
      var query = encodeURIComponent(name + ' ' + BENCHCORE_SCORE_SITE[category]);
      sheet.getRange(at, nameIndex + 1).setNote('新製品として自動で追加しました（' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd') + '、出品 ' + c.listings + ' 件、相場 約' + c.medianPrice + '円）。\n例: ' + String(c.example || '').slice(0, 80));
      sheet.getRange(at, scoreIndex + 1).setBackground(BENCHCORE_COLOR_NAME)
        .setNote(BENCHCORE_SCORE_SITE[category] + ' のスコアを入力してください。入力するとサイトのランキングに載ります。\n検索: https://www.google.com/search?q=' + query);
    });
  });

  try { benchcoreParts_(SpreadsheetApp.getActiveSpreadsheet(), priceData, dryRun, log); }
  catch (e) { log.push('パーツ最安値タブを更新できませんでした: ' + e.message); }

  Logger.log((dryRun ? '【プレビュー：シートは変更していません】' : '【反映しました】') + ' ' + log.length + ' 件');
  log.forEach(function (line) { Logger.log(line); });
  if (newDataMissing) Logger.log('新製品の候補を取得できなかったため、行の追加は行いませんでした');
}

// ---- メモリ・SSD・電源・マザーボードの最安値一覧と、人が入れる修正 ----
function benchcoreHeader_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (v) { return String(v).trim(); });
}

function benchcoreParts_(ss, priceData, dryRun, log) {
  // GPUのシートがあるスプレッドシートだけで行う（CPUとGPUの両方に書かない）
  var hasGpu = ss.getSheets().some(function (sheet) { return benchcoreHeader_(sheet).indexOf('GPU名') >= 0; });
  if (!hasGpu) return;
  var tz = 'Asia/Tokyo';
  var fixSheet = ss.getSheetByName(BENCHCORE_FIX_SHEET);
  if (!fixSheet && !dryRun) {
    fixSheet = ss.insertSheet(BENCHCORE_FIX_SHEET);
    fixSheet.getRange(1, 1, 1, BENCHCORE_FIX_HEADER.length).setValues([BENCHCORE_FIX_HEADER]);
    fixSheet.setFrozenRows(1);
  }
  // 1) 「パーツの修正」タブの内容を読む
  var fixes = {};
  var fixRows = [];
  if (fixSheet && fixSheet.getLastRow() >= 2) {
    var fh = benchcoreHeader_(fixSheet);
    var fc = {code: fh.indexOf('商品コード'), ex: fh.indexOf('除外する'), maker: fh.indexOf('正しいメーカー')};
    fixRows = fixSheet.getRange(2, 1, fixSheet.getLastRow() - 1, fh.length).getValues();
    fixRows.forEach(function (r) {
      var code = String(r[fc.code] || '').trim();
      if (code) fixes[code] = {exclude: r[fc.ex] === true || String(r[fc.ex]).toUpperCase() === 'TRUE', maker: String(r[fc.maker] || '').trim()};
    });
  }
  // 2) 「パーツ最安値」タブで付けられたチェック・メーカーの書き直しを、「パーツの修正」タブに移す
  var partsSheet = ss.getSheetByName(BENCHCORE_PARTS_SHEET);
  if (partsSheet && partsSheet.getLastRow() >= 2) {
    var ph = benchcoreHeader_(partsSheet);
    var pc = {kind: ph.indexOf('種類'), name: ph.indexOf('商品名'), code: ph.indexOf('商品コード'), ex: ph.indexOf('除外する'), maker: ph.indexOf('正しいメーカー')};
    if (pc.code >= 0 && pc.ex >= 0) {
      partsSheet.getRange(2, 1, partsSheet.getLastRow() - 1, ph.length).getValues().forEach(function (r) {
        var code = String(r[pc.code] || '').trim();
        var exclude = r[pc.ex] === true || String(r[pc.ex]).toUpperCase() === 'TRUE';
        var maker = pc.maker >= 0 ? String(r[pc.maker] || '').trim() : '';
        if (!code || (!exclude && !maker) || fixes[code]) return;
        fixes[code] = {exclude: exclude, maker: maker};
        log.push(BENCHCORE_FIX_SHEET + ' / ' + (exclude ? '除外' : 'メーカーを「' + maker + '」に修正') + ': ' + String(r[pc.name] || code).slice(0, 60) + (dryRun ? '（予定）' : ''));
        if (!dryRun) fixSheet.appendRow([code, r[pc.kind] || '', String(r[pc.name] || ''), exclude, maker, Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd'), '']);
      });
    }
  }
  // 3) 最新の最安値で「パーツ最安値」タブを書き直す
  var rows = (priceData.products || []).filter(function (p) {
    return BENCHCORE_PART_KINDS[p.category] && p.status === 'ok' && typeof p.price === 'number';
  }).map(function (p) {
    var spec = p.spec || {};
    var fix = fixes[p.itemCode] || {};
    var shop = p.shopName || '';
    return [BENCHCORE_PART_KINDS[p.category], spec.label || String(p.modelName).split('｜')[0], spec.maker || (p.category === 'ram' ? '—' : ''), p.price,
      shop, p.itemName || '', p.itemCode || '', Utilities.formatDate(new Date(p.fetchedAt), tz, 'yyyy/MM/dd HH:mm'), fix.exclude === true, fix.maker || ''];
  });
  // 内容が前回と同じなら書き直さない（毎日の無意味な更新とログを避ける）
  if (partsSheet && partsSheet.getLastRow() >= 1) {
    var current = partsSheet.getRange(1, 1, partsSheet.getLastRow(), BENCHCORE_PARTS_HEADER.length).getValues();
    if (JSON.stringify(current) === JSON.stringify([BENCHCORE_PARTS_HEADER].concat(rows))) return;
  }
  log.push(BENCHCORE_PARTS_SHEET + ': ' + rows.length + ' 件を書き出し' + (dryRun ? '（予定）' : ''));
  if (dryRun) return;
  if (!partsSheet) { partsSheet = ss.insertSheet(BENCHCORE_PARTS_SHEET); partsSheet.setFrozenRows(1); }
  partsSheet.clearContents();
  partsSheet.getRange(1, 1, 1, BENCHCORE_PARTS_HEADER.length).setValues([BENCHCORE_PARTS_HEADER]);
  if (rows.length) {
    partsSheet.getRange(2, 1, rows.length, BENCHCORE_PARTS_HEADER.length).setValues(rows);
    partsSheet.getRange(2, BENCHCORE_PARTS_HEADER.indexOf('除外する') + 1, rows.length, 1).insertCheckboxes();
  }
  partsSheet.getRange(1, 1).setNote('毎朝自動で書き直します。間違った商品は「除外する」にチェック、メーカーの判定違いは「正しいメーカー」に書いてください。'
    + '翌朝「パーツの修正」タブに保存され、その次の価格取得から反映されます。');
}
