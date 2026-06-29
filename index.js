#!/usr/bin/env node
/**
 * create-startup-api — scaffolds a Startup API-powered project.
 *
 * Usage:
 *   npm create startup-api [my-app] [-- --origin https://example.com] [--no-install]
 *
 * Currently this generates a Cloudflare Worker (powered by the
 * `@startup-api/cloudflare` package) that transparently proxies back to an
 * origin URL — the origin/object you provide during creation.
 */

import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { multiselect, isCancel } from '@clack/prompts';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, 'template');

// --- tiny ANSI helpers (no deps) -------------------------------------------
const tty = stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const cyan = (s) => c('36', s);
const red = (s) => c('31', s);

function fail(msg) {
  console.error(`\n${red('✖')} ${msg}\n`);
  process.exit(1);
}

// --- argument parsing -------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [], install: true, origin: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-install') out.install = false;
    else if (a === '--install') out.install = true;
    else if (a === '--origin' || a === '-o') out.origin = argv[++i];
    else if (a.startsWith('--origin=')) out.origin = a.slice('--origin='.length);
    else if (a === '--providers' || a === '-p') out.providers = argv[++i];
    else if (a.startsWith('--providers=')) out.providers = a.slice('--providers='.length);
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else out._.push(a);
  }
  return out;
}

function normalizeOrigin(input) {
  let v = (input || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    return u.toString();
  } catch {
    return null;
  }
}

function isEmptyDir(dir) {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  const entries = readdirSync(dir).filter((e) => e !== '.git' && e !== '.DS_Store');
  return entries.length === 0;
}

// --- login providers -------------------------------------------------------
// A provider must be rendered into three places: the createStartupAPI factory
// (src/index.ts), the local .dev.vars, and README.md setup instructions. Each
// entry below carries the pieces needed for all three; the env var names are
// derived from the key (e.g. google -> GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
const PROVIDERS = {
  google: {
    label: 'Google',
    register: 'https://console.cloud.google.com/ → APIs & Services → Credentials',
    // Lines placed inside `providers: { ... }` in src/index.ts (4-space indent).
    factory: [
      '    // Enabled once GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set.',
      '    google: {',
      "      // scopes: 'https://www.googleapis.com/auth/calendar.readonly',",
      '    },',
    ],
  },
  twitch: {
    label: 'Twitch',
    register: 'https://dev.twitch.tv/console',
    factory: [
      '    // Enabled once TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are set.',
      '    twitch: {',
      "      // scopes: 'channel:read:subscriptions',",
      '    },',
    ],
  },
  patreon: {
    label: 'Patreon',
    register: 'https://www.patreon.com/portal/registration/register-clients',
    factory: [
      '    // Enabled once PATREON_CLIENT_ID / PATREON_CLIENT_SECRET are set.',
      '    patreon: {',
      '      // Request membership data so entitlements (active patron, tiers,',
      '      // benefits) can be read and forwarded to your origin.',
      "      // scopes: 'identity.memberships',",
      "      // campaignId: '<CAMPAIGN_ID>',",
      '      // Keep entitlements fresh. `cron` also needs a matching `triggers.crons`',
      '      // in wrangler.jsonc; `webhook` also needs PATREON_WEBHOOK_SECRET in env.',
      "      // freshness: { ttl: true, cron: { schedule: '0 */6 * * *' }, webhook: true },",
      '    },',
    ],
    // Patreon webhook freshness needs an extra secret.
    extraSecret: 'PATREON_WEBHOOK_SECRET',
  },
  atproto: {
    label: 'AT Protocol (Bluesky)',
    // A public OAuth client (PKCE/DPoP/PAR): no client id/secret, no app to
    // register. Including the factory key enables it; ATPROTO_ENABLED is the
    // credential-free env alternative.
    credentials: false,
    factory: [
      '    // AT Protocol (Atmosphere) — a public OAuth client: no client id/secret',
      '    // and nothing to register. Including this key enables it (or set',
      '    // ATPROTO_ENABLED truthy in env). Users sign in with their handle/DID.',
      '    atproto: {',
      "      // clientName: 'My App', // shown on the consent screen (default 'StartupAPI')",
      "      // scopes: 'transition:generic', // extra scopes on top of the base 'atproto'",
      '    },',
    ],
  },
};
const PROVIDER_KEYS = Object.keys(PROVIDERS);
const idVar = (key) => `${key.toUpperCase()}_CLIENT_ID`;
const secretVar = (key) => `${key.toUpperCase()}_CLIENT_SECRET`;
const hasCredentials = (key) => PROVIDERS[key].credentials !== false;
const providerLabels = (keys) => keys.map((k) => PROVIDERS[k].label).join(', ');

// Parse a comma/space-separated provider list into known + unknown buckets.
function parseProviders(input) {
  const selected = [];
  const unknown = [];
  for (const tok of String(input ?? '').split(/[\s,]+/)) {
    const key = tok.trim().toLowerCase();
    if (!key || key === 'none') continue;
    if (PROVIDERS[key]) {
      if (!selected.includes(key)) selected.push(key);
    } else if (!unknown.includes(key)) {
      unknown.push(key);
    }
  }
  return { selected, unknown };
}

function warnUnknownProviders(unknown) {
  if (unknown.length) {
    console.log(
      `  ${red(`Ignoring unknown provider(s): ${unknown.join(', ')}`)} ` +
        `${dim(`(known: ${PROVIDER_KEYS.join(', ')})`)}`,
    );
  }
}

// The `providers: { ... }` block for src/index.ts.
function renderProvidersConfig(selected) {
  if (selected.length === 0) {
    return [
      '  providers: {',
      '    // No login providers were enabled at creation time. Add one here and',
      '    // set its *_CLIENT_ID / *_CLIENT_SECRET to turn it on. Supported:',
      `    // ${PROVIDER_KEYS.join(', ')}. See README.md and .dev.vars.example.`,
      '  },',
    ].join('\n');
  }
  const blocks = selected.map((k) => PROVIDERS[k].factory.join('\n')).join('\n');
  return `  providers: {\n${blocks}\n  },`;
}

// The auth-provider portion of the generated .dev.vars.
function renderDevVarsProviders(selected) {
  if (selected.length === 0) {
    return (
      `# No auth providers were selected at creation time. To enable one, add its\n` +
      `# client id + secret here (see .dev.vars.example) and configure it in src/index.ts.\n`
    );
  }
  let out =
    `# Auth providers (enabled: ${providerLabels(selected)}), configured in src/index.ts.\n` +
    `# Fill in any credentials below to sign in during \`npm run dev\`.\n`;
  for (const k of selected) {
    if (!hasCredentials(k)) {
      out += `\n# ${PROVIDERS[k].label} — no credentials needed (enabled in src/index.ts).\n`;
      continue;
    }
    out +=
      `\n# ${PROVIDERS[k].label} — ${PROVIDERS[k].register}\n` +
      `# Redirect URI: <your-worker-url>/users/auth/${k}/callback\n` +
      `${idVar(k)}=""\n` +
      `${secretVar(k)}=""\n`;
    if (PROVIDERS[k].extraSecret) {
      out +=
        `# Only needed when Patreon webhook freshness is enabled in src/index.ts.\n` +
        `# ${PROVIDERS[k].extraSecret}=""\n`;
    }
  }
  return out;
}

// The README "## Login providers" section with per-provider setup steps.
function renderReadmeSection(selected) {
  if (selected.length === 0) {
    return (
      `## Login providers\n\n` +
      `No login providers were enabled at creation time. To add one, set its\n` +
      `\`*_CLIENT_ID\` / \`*_CLIENT_SECRET\` (locally in \`.dev.vars\`, in production as\n` +
      `Wrangler secrets) and add it to \`providers\` in [src/index.ts](src/index.ts).\n` +
      `Supported providers: ${providerLabels(PROVIDER_KEYS)}. See\n` +
      `[.dev.vars.example](.dev.vars.example) for the variable names.\n`
    );
  }
  let out =
    `## Login providers\n\n` +
    `This project was scaffolded with **${providerLabels(selected)}** enabled, configured\n` +
    `in \`providers\` in [src/index.ts](src/index.ts). Credential-based providers turn on\n` +
    `once their client id and secret are present (placeholders are already in \`.dev.vars\`).\n` +
    `To finish setup for each provider:\n`;
  for (const k of selected) {
    out += `\n### ${PROVIDERS[k].label}\n\n`;
    if (k === 'atproto') {
      out +=
        `AT Protocol (Atmosphere) login is decentralized: there is **no provider to register\n` +
        `with and no client secret**. The worker is a public OAuth client identified by a\n` +
        `metadata document it serves itself.\n\n` +
        `1. Already enabled — its key is in \`providers\` in [src/index.ts](src/index.ts). To\n` +
        `   toggle it per deployment without code, set \`ATPROTO_ENABLED\` truthy instead.\n` +
        `2. Deploy over **HTTPS** with a stable hostname. The worker automatically serves its\n` +
        `   client metadata at \`https://<your-worker-url>/users/auth/atproto/client-metadata.json\`\n` +
        `   (this URL is the OAuth \`client_id\`) and registers the redirect URI\n` +
        `   \`https://<your-worker-url>/users/auth/atproto/callback\`.\n` +
        `3. That's it — visitors sign in with their handle (e.g. \`alice.bsky.social\`) or DID;\n` +
        `   their own server handles authentication. No secret to set.\n`;
      continue;
    }
    out +=
      `1. Register an OAuth client: ${PROVIDERS[k].register}\n` +
      `2. Add these redirect URIs to the client:\n` +
      `   - Local dev: \`http://localhost:8787/users/auth/${k}/callback\`\n` +
      `   - Production: \`https://<your-worker-url>/users/auth/${k}/callback\`\n` +
      `3. Put \`${idVar(k)}\` and \`${secretVar(k)}\` in \`.dev.vars\` for local development.\n` +
      `4. For production, set the client id as a \`vars\` entry in [wrangler.jsonc](wrangler.jsonc)\n` +
      `   (or the dashboard) and the secret with Wrangler:\n` +
      `   \`\`\`bash\n` +
      `   npx wrangler secret put ${secretVar(k)}\n` +
      `   \`\`\`\n`;
    if (k === 'patreon') {
      out +=
        `5. (Optional) To read entitlements, set the Patreon campaignId and the\n` +
        `   identity.memberships scope in [src/index.ts](src/index.ts). Webhook freshness\n` +
        `   additionally requires the \`PATREON_WEBHOOK_SECRET\` secret.\n`;
    }
  }
  return out;
}

// The `wrangler secret put` lines for the README Deploy section.
function renderDeploySecrets(selected) {
  const withSecrets = selected.filter(hasCredentials);
  if (withSecrets.length === 0) {
    return '# (no auth provider secrets to set)';
  }
  return withSecrets.map((k) => `npx wrangler secret put ${secretVar(k)}`).join('\n');
}

const WORKER_PKG = '@startup-api/cloudflare';
// Respect a configured registry (npm sets npm_config_registry when run via
// `npm create`); default to the public registry otherwise.
const REGISTRY = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(
  /\/+$/,
  '',
);

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return res.text();
}

// Resolve the worker package version + canonical wrangler template to scaffold
// with. We query the registry for the *latest* published version at creation
// time (and fetch that exact version's wrangler template) so generated projects
// are always pinned to the newest release. Falls back to the copy bundled as
// our own dependency when the network is unavailable.
async function resolveWorkerPackage() {
  try {
    const meta = JSON.parse(await fetchText(`${REGISTRY}/${WORKER_PKG}/latest`));
    if (!meta.version) throw new Error('registry response missing a version');
    const wranglerTemplate = await fetchText(
      `https://unpkg.com/${WORKER_PKG}@${meta.version}/wrangler.template.jsonc`,
    );
    return { version: meta.version, wranglerTemplate };
  } catch (err) {
    console.warn(
      `${dim('!')} Could not fetch the latest ${WORKER_PKG} from the registry (${err.message}).\n` +
        `  ${dim('Falling back to the bundled copy.')}`,
    );
  }

  // Offline fallback: the package bundled as our own dependency.
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${WORKER_PKG}/package.json`);
  } catch {
    fail(
      'Could not resolve the `@startup-api/cloudflare` package.\n' +
        '  This is a dependency of create-startup-api; try reinstalling.',
    );
  }
  const root = dirname(pkgJsonPath);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const wranglerTemplate = readFileSync(join(root, 'wrangler.template.jsonc'), 'utf8');
  return { version: pkg.version, wranglerTemplate };
}

// Recursively copy template/, applying placeholder substitution and the
// dotfile renames npm strips on publish.
const RENAMES = {
  _gitignore: '.gitignore',
  'dev.vars.example': '.dev.vars.example',
};

function copyTemplate(srcDir, destDir, vars) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const outName = RENAMES[entry.name] || entry.name;
    const destPath = join(destDir, outName);
    if (entry.isDirectory()) {
      copyTemplate(srcPath, destPath, vars);
    } else {
      let content = readFileSync(srcPath, 'utf8');
      for (const [k, val] of Object.entries(vars)) {
        content = content.replaceAll(k, val);
      }
      writeFileSync(destPath, content);
    }
  }
}

function applyVars(str, vars) {
  for (const [k, val] of Object.entries(vars)) str = str.replaceAll(k, val);
  return str;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\n${bold('create-startup-api')} ${dim('· Startup API project scaffolder')}\n`);

  // Input model:
  //   --yes        → never prompt; everything must come from flags.
  //   TTY          → interactive readline prompts.
  //   piped stdin  → answers are read line-by-line from the buffered input.
  // When input is exhausted, `ask` returns its fallback; callers with no
  // sensible default fail with a clear error.
  const useReadline = stdin.isTTY && !args.yes;
  const rl = useReadline ? createInterface({ input: stdin, output: stdout }) : null;

  let pipedLines = null;
  if (!useReadline && !args.yes && !stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    pipedLines = text.length ? text.split(/\r?\n/) : [];
  }

  const canPrompt = () => !!rl || (pipedLines && pipedLines.length > 0);

  const ask = async (q, fallback) => {
    if (rl) {
      const a = (await rl.question(q)).trim();
      return a || fallback;
    }
    if (pipedLines && pipedLines.length) {
      stdout.write(q);
      const a = pipedLines.shift().trim();
      stdout.write(`${a}\n`);
      return a || fallback;
    }
    return fallback;
  };

  try {
    // 1. Project name / directory ------------------------------------------
    let projectName = args._[0];
    if (!projectName) {
      projectName = await ask(`${cyan('?')} Project name: `, 'my-startup');
    }
    projectName = projectName.trim().replace(/\/+$/, '');
    if (!projectName) fail('A project name is required.');

    const targetDir = resolve(process.cwd(), projectName);
    const pkgName = basename(targetDir)
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'startup-app';

    if (!isEmptyDir(targetDir)) {
      fail(`Target directory ${cyan(targetDir)} already exists and is not empty.`);
    }

    // 2. Origin URL (what the worker proxies back to) ----------------------
    let origin = normalizeOrigin(args.origin);
    while (!origin) {
      if (!canPrompt()) {
        fail('A valid origin URL is required. Pass it with --origin <url>.');
      }
      const answer = await ask(
        `${cyan('?')} Origin URL to proxy to ${dim('(e.g. https://your-app.com)')}: `,
        '',
      );
      origin = normalizeOrigin(answer);
      if (!origin && stdin.isTTY) {
        console.log(`  ${red('Please enter a valid URL.')}`);
      }
    }

    // 3. Login providers to enable -----------------------------------------
    //    --providers wins; otherwise an interactive checkbox list on a TTY, or
    //    a comma-separated line from piped stdin. Unknown names warn; none = [].
    let providers;
    if (args.providers !== undefined) {
      const sel = parseProviders(args.providers);
      warnUnknownProviders(sel.unknown);
      providers = sel.selected;
    } else if (useReadline) {
      rl.close(); // release stdin before clack takes it over in raw mode
      const picked = await multiselect({
        message: 'Login providers to enable',
        options: PROVIDER_KEYS.map((k) => ({ value: k, label: PROVIDERS[k].label })),
        required: false,
      });
      if (isCancel(picked)) fail('Cancelled.');
      providers = picked;
    } else if (pipedLines && pipedLines.length) {
      const sel = parseProviders(
        await ask(
          `${cyan('?')} Login providers to enable ` +
            `${dim(`(comma-separated: ${PROVIDER_KEYS.join(', ')}; blank for none)`)}: `,
          '',
        ),
      );
      warnUnknownProviders(sel.unknown);
      providers = sel.selected;
    } else {
      providers = [];
    }

    rl?.close();

    // 4. Gather template data ----------------------------------------------
    const worker = await resolveWorkerPackage();
    const sessionSecret = randomBytes(32).toString('hex');
    const vars = {
      __PROJECT_NAME__: pkgName,
      __ORIGIN_URL__: origin,
      __WORKER_VERSION__: `^${worker.version}`,
      __PROVIDERS_CONFIG__: renderProvidersConfig(providers),
      __PROVIDER_SECTION__: renderReadmeSection(providers),
      __DEPLOY_SECRET_CMDS__: renderDeploySecrets(providers),
    };

    console.log(`\n${dim('Scaffolding into')} ${cyan(targetDir)}\n`);

    // 5. Copy the static template ------------------------------------------
    copyTemplate(TEMPLATE_DIR, targetDir, vars);

    // 6. Generate wrangler.jsonc from the worker package's canonical template
    const wranglerOut = applyVars(worker.wranglerTemplate, vars);
    writeFileSync(join(targetDir, 'wrangler.jsonc'), wranglerOut);

    // 7. Write local dev secrets (gitignored) so `wrangler dev` works at once.
    //    Required values are filled in; selected auth providers get credential
    //    placeholders to fill (each is configured in src/index.ts via the
    //    createStartupAPI factory). See .dev.vars.example for all providers.
    const devVars =
      `# Local development secrets for \`wrangler dev\` (gitignored).\n` +
      `SESSION_SECRET="${sessionSecret}"\n` +
      `ORIGIN_URL="${origin}"\n` +
      `\n` +
      renderDevVarsProviders(providers);
    writeFileSync(join(targetDir, '.dev.vars'), devVars);

    // 8. Install dependencies (runs the project's sync-assets postinstall) --
    let installed = false;
    if (args.install) {
      console.log(`${dim('Installing dependencies with npm…')}\n`);
      const res = spawnSync('npm', ['install'], { cwd: targetDir, stdio: 'inherit' });
      installed = res.status === 0;
      if (!installed) {
        console.log(`\n${red('npm install failed')} — you can run it manually below.`);
      }
    }

    // 9. Next steps ---------------------------------------------------------
    const rel = projectName;
    console.log(`\n${green('✔')} ${bold('Created your Startup API project!')}\n`);
    console.log(`  Origin (proxied to): ${cyan(origin)}`);
    console.log(
      `  Login providers:     ${cyan(providers.length ? providerLabels(providers) : 'none')}\n`,
    );
    console.log(bold('  Next steps:\n'));
    console.log(`    cd ${rel}`);
    if (!installed) console.log('    npm install');
    console.log(`    npm run dev            ${dim('# local dev at http://localhost:8787')}`);
    console.log('');
    console.log(`    npm run deploy         ${dim('# deploy to Cloudflare')}`);
    console.log(
      `    npx wrangler secret put SESSION_SECRET   ${dim('# set the production session secret')}`,
    );
    if (providers.length) {
      console.log(
        `\n  ${dim('Finish login setup: add credentials for')} ${cyan(providerLabels(providers))} ${dim('to')}\n` +
          `  ${cyan('.dev.vars')}${dim('. See the "Login providers" section of')} ${cyan('README.md')}.\n`,
      );
    } else {
      console.log(
        `\n  ${dim('No login providers enabled. Add one anytime in')} ${cyan('src/index.ts')}${dim('. See')} ${cyan('README.md')}.\n`,
      );
    }
  } finally {
    rl?.close();
  }
}

main().catch((err) => fail(err?.stack || String(err)));
