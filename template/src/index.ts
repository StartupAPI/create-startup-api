/**
 * Worker entrypoint.
 *
 * The application logic lives in the `@startup-api/cloudflare` package. This
 * file builds a configured instance with the `createStartupAPI` factory and
 * re-exports its fetch handler and Durable Object classes so Wrangler can
 * discover them.
 *
 * Two layers of configuration work together:
 *
 *   1. Environment variables (in `wrangler.jsonc` `vars`, `.dev.vars`, or the
 *      Cloudflare dashboard) hold credentials/secrets and per-deployment
 *      values: `ORIGIN_URL`, `SESSION_SECRET`, the `*_CLIENT_ID` /
 *      `*_CLIENT_SECRET` pairs, `AUTH_ORIGIN`, `USERS_PATH`, `ADMIN_IDS`.
 *      A provider turns on automatically once its client id + secret are set.
 *
 *   2. The factory config below holds non-secret behavior: which providers to
 *      configure, extra OAuth scopes, the Patreon campaign id, entitlement
 *      freshness, and the access policy.
 *
 * See README.md for the full list of variables and factory options.
 */
import { createStartupAPI } from '@startup-api/cloudflare';

const api = createStartupAPI({
  providers: {
    // Enabled automatically when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set.
    google: {
      // scopes: 'https://www.googleapis.com/auth/calendar.readonly',
    },
    // Enabled automatically when TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are set.
    twitch: {
      // scopes: 'channel:read:subscriptions',
    },
    // Enabled automatically when PATREON_CLIENT_ID / PATREON_CLIENT_SECRET are set.
    patreon: {
      // Request membership data so entitlements (active patron, tiers, benefits)
      // can be read and forwarded to your origin.
      // scopes: 'identity.memberships',
      // campaignId: '<CAMPAIGN_ID>',
      // Keep entitlements fresh. `cron` also needs a matching `triggers.crons`
      // in wrangler.jsonc; `webhook` also needs PATREON_WEBHOOK_SECRET in env.
      // freshness: { ttl: true, cron: { schedule: '0 */6 * * *' }, webhook: true },
    },
  },

  // Gate paths and forward login/entitlement status to your origin. When no
  // policy is set every path is public (and identity headers are still
  // forwarded when a visitor is signed in).
  // accessPolicy: {
  //   rules: [
  //     { pattern: '/', requirement: { mode: 'public' } },
  //     { pattern: '/app/*', requirement: { mode: 'authenticated' }, on_unauthorized: 'login' },
  //   ],
  //   default: { mode: 'public' },
  // },
});

// `api.default` includes a `scheduled()` handler only when a provider enables
// cron freshness above.
export default api.default;
export const { UserDO, AccountDO, SystemDO, CredentialDO } = api;
