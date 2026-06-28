# __PROJECT_NAME__

A [Startup API](https://startupapi.com)-powered Cloudflare Worker, created with
`npm create startup-api`. It transparently proxies requests to your origin and
layers on user accounts, authentication, and other Startup API features.

The worker logic lives in the [`@startup-api/cloudflare`](https://github.com/StartupAPI/startup-api-cloudflare)
package. This project is a thin wrapper: a [src/index.ts](src/index.ts) that
builds a configured instance with the `createStartupAPI` factory and re-exports
it, plus per-deployment settings in [wrangler.jsonc](wrangler.jsonc) and
`.dev.vars`. Upgrade the framework by bumping the `@startup-api/cloudflare`
dependency.

Configuration is split in two:

- **Environment variables** (`.dev.vars`, `wrangler.jsonc` `vars`, or the
  dashboard) hold **credentials and secrets** plus per-deployment values:
  `ORIGIN_URL`, `SESSION_SECRET`, the OAuth `*_CLIENT_ID` / `*_CLIENT_SECRET`
  pairs, `AUTH_ORIGIN`, `USERS_PATH`, `ADMIN_IDS`. A provider turns on
  automatically once its client id and secret are present.
- **The `createStartupAPI` factory** in [src/index.ts](src/index.ts) holds
  non-secret **behavior**: which providers to configure, extra OAuth scopes,
  the Patreon campaign id, entitlement freshness, and the access policy.

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
block of [wrangler.jsonc](wrangler.jsonc). Keep secrets out of source control —
set them with `wrangler secret put`:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TWITCH_CLIENT_SECRET
npx wrangler secret put PATREON_CLIENT_SECRET
```

## Configuration

### Environment variables (credentials & per-deployment values)

| Variable                | Required | Description                                                     |
| :---------------------- | :------- | :-------------------------------------------------------------- |
| `ORIGIN_URL`            | **Yes**  | Base URL of the origin/object this worker proxies to.           |
| `SESSION_SECRET`        | **Yes**  | Secret used to sign session cookies (set as a Wrangler secret). |
| `USERS_PATH`            | No       | Path for internal assets (default `/users/`).                   |
| `AUTH_ORIGIN`           | No       | Base URL for OAuth redirects (overrides request origin).        |
| `GOOGLE_CLIENT_ID`      | No       | Google OAuth2 client ID.                                        |
| `GOOGLE_CLIENT_SECRET`  | No       | Google OAuth2 client secret.                                    |
| `TWITCH_CLIENT_ID`      | No       | Twitch OAuth2 client ID.                                        |
| `TWITCH_CLIENT_SECRET`  | No       | Twitch OAuth2 client secret.                                    |
| `PATREON_CLIENT_ID`     | No       | Patreon OAuth2 client ID.                                       |
| `PATREON_CLIENT_SECRET` | No       | Patreon OAuth2 client secret.                                   |
| `PATREON_WEBHOOK_SECRET`| No       | Secret for verifying Patreon webhook signatures.                |
| `ADMIN_IDS`             | No       | Comma-separated admin user IDs.                                 |

Setting a provider's client id and secret enables it. Redirect URIs follow the
pattern `https://<your-worker-url>/users/auth/<provider>/callback`.

### Factory configuration (behavior)

OAuth scopes, the Patreon campaign id, entitlement freshness, and the access
policy are configured in [src/index.ts](src/index.ts) by passing a config object
to `createStartupAPI`:

```ts
import { createStartupAPI } from '@startup-api/cloudflare';

const api = createStartupAPI({
  providers: {
    google: {},
    twitch: {},
    patreon: {
      scopes: 'identity.memberships',
      campaignId: '<CAMPAIGN_ID>',
      freshness: { ttl: true },
    },
  },
  // accessPolicy: { rules: [/* ... */], default: { mode: 'public' } },
});

export default api.default;
export const { UserDO, AccountDO, SystemDO, CredentialDO } = api;
```

Enabling a provider's `freshness.cron` also requires a matching `triggers.crons`
in [wrangler.jsonc](wrangler.jsonc); `freshness.webhook` (Patreon) requires
`PATREON_WEBHOOK_SECRET` and a webhook pointed at
`<your-worker-url>/users/webhooks/patreon`.

## Updating the framework

```bash
npm run update-startup-api   # install the latest @startup-api/cloudflare + refresh ./public/users
```

This installs the newest published `@startup-api/cloudflare` (across minor/major
versions) and re-runs `sync-assets` via the postinstall hook. To stay within your
current semver range instead, use `npm update @startup-api/cloudflare`.
