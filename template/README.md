# __PROJECT_NAME__

A [Startup API](https://startupapi.com)-powered Cloudflare Worker, created with
`npm create startup-api`. It transparently proxies requests to your origin and
layers on user accounts, authentication, and other Startup API features.

The worker logic lives in the [`@startup-api/cloudflare`](https://github.com/StartupAPI/startup-api-cloudflare)
package. This project is a thin wrapper: a [src/index.ts](src/index.ts) that
re-exports the worker, plus your own configuration in [wrangler.jsonc](wrangler.jsonc).
Upgrade the framework by bumping the `@startup-api/cloudflare` dependency.

## Develop

```bash
npm install      # also syncs framework assets into ./public
npm run dev      # http://localhost:8787
```

Local secrets live in `.dev.vars` (gitignored); a `SESSION_SECRET` was generated
for you at creation time. See [.dev.vars.example](.dev.vars.example) for all
supported variables.

## Deploy

```bash
npm run deploy
npx wrangler secret put SESSION_SECRET   # set the production session secret
```

Set `ORIGIN_URL` and any OAuth credentials in the Cloudflare dashboard
(**Workers & Pages → your worker → Settings → Variables**) or in the `vars`
block of [wrangler.jsonc](wrangler.jsonc).

## Configuration

| Variable               | Required | Description                                                    |
| :--------------------- | :------- | :------------------------------------------------------------- |
| `ORIGIN_URL`           | **Yes**  | Base URL of the origin/object this worker proxies to.          |
| `SESSION_SECRET`       | **Yes**  | Secret used to sign session cookies (set as a Wrangler secret).|
| `USERS_PATH`           | No       | Path for internal assets (default `/users/`).                  |
| `AUTH_ORIGIN`          | No       | Base URL for OAuth redirects (overrides request origin).       |
| `GOOGLE_CLIENT_ID`     | No       | Google OAuth2 client ID.                                       |
| `GOOGLE_CLIENT_SECRET` | No       | Google OAuth2 client secret.                                   |
| `TWITCH_CLIENT_ID`     | No       | Twitch OAuth2 client ID.                                       |
| `TWITCH_CLIENT_SECRET` | No       | Twitch OAuth2 client secret.                                   |
| `ADMIN_IDS`            | No       | Comma-separated admin user IDs.                                |

## Updating the framework

```bash
npm update @startup-api/cloudflare   # re-runs sync-assets to refresh ./public/users
```
