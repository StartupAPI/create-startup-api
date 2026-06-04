/**
 * Worker entrypoint.
 *
 * All application logic lives in the `@startup-api/cloudflare` package — this
 * file just re-exports its fetch handler and Durable Object classes so
 * Wrangler can discover them. To customize behavior, configure `wrangler.jsonc`
 * (ORIGIN_URL, OAuth credentials, etc.) rather than editing this file.
 *
 * To diverge from the framework's request handling, replace the re-export
 * below with your own `export default { async fetch(request, env) { … } }` and
 * delegate to the package where useful.
 */
export { default, UserDO, AccountDO, SystemDO, CredentialDO } from '@startup-api/cloudflare';
