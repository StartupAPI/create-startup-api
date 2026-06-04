# create-startup-api

Scaffold a [Startup API](https://startupapi.com)-powered project in seconds.

```bash
npm create startup-api
# or
npm create startup-api my-app -- --origin https://your-app.com
```

## What it does

Generates a Cloudflare Worker that uses the
[`@startup-api/cloudflare`](https://github.com/StartupAPI/startup-api-cloudflare)
package to transparently **proxy requests to an origin** (or another object you
specify) while adding user accounts, authentication, and other Startup API
features on top.

The framework ships as an npm dependency, so the generated project stays tiny —
a `src/index.ts` that re-exports the worker plus a `wrangler.jsonc` you own.
Upgrades are a `npm update @startup-api/cloudflare` away.

## Usage

```
npm create startup-api [name] [-- <options>]
```

| Option              | Description                                                        |
| :------------------ | :----------------------------------------------------------------- |
| `name`              | Target directory / project name. Prompted if omitted.             |
| `--origin <url>`    | Origin URL the worker proxies to. Prompted if omitted.            |
| `--no-install`      | Skip running `npm install` in the new project.                    |
| `--yes`, `-y`       | Non-interactive; requires `name` and `--origin`.                   |

After creation:

```bash
cd my-app
npm run dev       # local dev at http://localhost:8787
npm run deploy    # deploy to Cloudflare
```

A random `SESSION_SECRET` is generated into `.dev.vars` for local development;
set the production secret with `npx wrangler secret put SESSION_SECRET`.

## License

Apache-2.0
