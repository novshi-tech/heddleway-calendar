# デプロイ

1 人(か、一緒に使う数人)に 1 つ。どの組織のものでもないので、本人の Cloudflare アカウントに置く(docs/adr/0002 の決定 3)。

## 1. サインインの OIDC クライアント

Google の場合、Google Cloud のコンソールで OAuth クライアント(ウェブ アプリケーション)を作る。

- 承認済みのリダイレクト URI: `https://<このツール>/auth/callback`
- クライアント ID を `OIDC_CLIENT_ID`、シークレットを `OIDC_CLIENT_SECRET` にする

Entra ID なら `IDP_TYPE` を `entra`、`OIDC_ISSUER` を `https://login.microsoftonline.com/<テナント ID>/v2.0` にする。

## 2. Worker と D1

```bash
cp wrangler.example.jsonc wrangler.jsonc   # PUBLIC_URL・OIDC_CLIENT_ID・ALLOWED_EMAILS・GATEWAYS を書く
npx wrangler d1 create heddleway-calendar  # 出てきた database_id を wrangler.jsonc に
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET     # openssl rand -base64 32
npx wrangler deploy
```

`SESSION_SECRET` を変えると、全員がサインアウトし、保存した接続も読めなくなる(つなぎ直す)。

## 3. 各組織の Heddleway に、アプリとして登録する

その組織の管理者が、ゲートウェイの管理画面「アプリ」(`/admin/apps`)に `https://<このツール>/client.json` を入れる。口(サービス・メソッド・パス)と例の照合の結果が出るので、見て承認する。登録しないと、つなぐときに「このアプリは、この組織のゲートウェイに登録されていません」と出る。

口を変えたら(`src/app.ts`)、各組織でもう一度取り直して承認してもらう。登録は承認した時点の定義の写しなので、承認し直すまで新しい口は通らない。
