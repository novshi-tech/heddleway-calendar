# heddleway-calendar

複数の [Heddleway](https://github.com/novshi-tech/heddleway) のデプロイにつなぎ、それぞれの組織のカレンダーの自分の予定を 1 つの画面にまとめて見るツール。Heddleway の「アプリ」(Heddleway の `docs/adr/0008`)の 1 つ目。

- 今あるのは統合ビュー([docs/adr/0002](docs/adr/0002-first-cut-unified-view.md))。ほかのカレンダーに「予定あり」を写す同期は、まだない([docs/adr/0001](docs/adr/0001-separate-tool-across-instances.md))
- 予定は開いたときに各デプロイから読み、保存しない。持つのは接続(許可のトークン)だけ
- 使える口は、メインのカレンダーの予定の読み取りだけ(`src/app.ts`)

## 使い方

1. 各組織の Heddleway の管理者が、管理画面の「アプリ」(`/admin/apps`)に `https://<このツール>/client.json` を入れて承認する
2. このツールにサインインし、「接続」の画面で組織の Heddleway の URL を入れて「つなぐ」。その組織のアカウントでサインインして許可する
3. トップに、つないだ組織の予定が 7 日分並ぶ

その組織の Heddleway に、Google Calendar か Microsoft Graph の接続がいる。

## 開発

```bash
npm ci
npm run typecheck
npm test
npm run dev   # wrangler dev(wrangler.example.jsonc)
```

デプロイの手順は [docs/deploy.md](docs/deploy.md)。
