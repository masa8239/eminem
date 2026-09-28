# BENCHCORE

画面は `index.html` だけで構成し、楽天市場の価格取得のみ Vercel Function (`/api/rakuten-prices`) を利用します。認証情報がブラウザへ渡ることはありません。

## 楽天市場の商品対応表を登録する

初期状態の `config/rakuten-products.json` は空です。**商品コードを推測して登録しないでください。** 楽天市場の商品ページまたは楽天APIで、対象モデルそのもの（容量・型番・セット内容を含む）だと確認できた商品だけを登録します。

1. 楽天の商品コード（`ショップコード:商品管理番号` 形式）を確認します。
2. `config/rakuten-products.json` に次の形式で追加します。`modelName` は画面・スプレッドシート上のモデル名と完全一致させ、`category` は `cpu`、`gpu`、`ram` のいずれかにします。

   ```json
   [
     {
       "category": "cpu",
       "modelName": "（BENCHCORE上の完全一致するモデル名）",
       "itemCode": "（確認済みのショップコード:商品管理番号）"
     }
   ]
   ```

3. Pull Requestで、商品コードとモデルが一致することをレビューしてからデプロイします。

未登録モデルは従来の参考価格のままで、楽天の価格としては表示されません。登録商品の取得に失敗した場合も参考価格を残しますが、「更新失敗」と表示し、取得日時のない価格を最新価格として扱いません。成功時だけ楽天価格、取得日時、取得元、商品リンクを表示します。

## Vercel の環境変数

Production に次の3項目を設定します（値をリポジトリや `index.html` に書かないでください）。

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `RAKUTEN_AFFILIATE_ID`

ローカルでFunctionを確認する場合は同じ変数を `.env.local` に設定して `vercel dev` を実行します。対応表が空なら認証情報なしでも空の正常レスポンスを返します。

## テスト

```sh
npm test
```
