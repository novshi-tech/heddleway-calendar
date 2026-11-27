# CLAUDE.md

heddleway-calendar: 複数の Heddleway のデプロイにつなぎ、自分の予定を 1 つの画面にまとめて見るツール。Heddleway の「アプリ」(novshi-tech/heddleway の docs/adr/0008)。決定の経緯は `docs/adr/`。

## Commands

```bash
npm run dev        # wrangler dev(wrangler.jsonc を wrangler.example.jsonc から作る)
npm run typecheck  # tsc --noEmit
npm test           # vitest(純粋な関数だけ)
```

npm を使う(`npm ci`)。`.npmrc` で `legacy-peer-deps` を有効にしている。Node は `.node-version`(22)。

## 構成

- Cloudflare Workers + D1、TypeScript strict。フレームワークは使わない。画面はサーバーで組む HTML で、スクリプトはない
- `src/index.ts` ルーティング。`src/auth.ts` 本人のサインイン(OIDC、`ALLOWED_EMAILS`)
- `src/app.ts` アプリの定義(`/client.json`、使える口)。口を変えたら各組織で承認し直しが要る
- `src/gateway.ts` デプロイへの OAuth(公開クライアント、PKCE)、MCP の `list_credentials`・`issue_token`、REST の中継
- `src/sources.ts` 接続ごとに予定を読む(Google Calendar・Graph)。`src/events.ts` 予定の正規化と日ごとの並べ方(純粋な関数)
- `src/store.ts` D1 の接続(トークンは `src/crypto.ts` で暗号化)。`src/pages.ts`・`src/client/app.css` 画面(モバイルファースト、ライト/ダーク)

## 線引き

- 予定は保存しない。持つのは接続だけ(docs/adr/0001 の決定 3)
- 元の予定は書き換えない。予定を作る・変えるのはカレンダーの画面かエージェント
- `wrangler.jsonc` はコミットしない
- 文面は日本語。コードの識別子とコメントは英語
