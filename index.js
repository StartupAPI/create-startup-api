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

    rl?.close();

    // 3. Gather template data ----------------------------------------------
    const worker = await resolveWorkerPackage();
    const sessionSecret = randomBytes(32).toString('hex');
    const vars = {
      __PROJECT_NAME__: pkgName,
      __ORIGIN_URL__: origin,
      __WORKER_VERSION__: `^${worker.version}`,
    };

    console.log(`\n${dim('Scaffolding into')} ${cyan(targetDir)}\n`);

    // 4. Copy the static template ------------------------------------------
    copyTemplate(TEMPLATE_DIR, targetDir, vars);

    // 5. Generate wrangler.jsonc from the worker package's canonical template
    const wranglerOut = applyVars(worker.wranglerTemplate, vars);
    writeFileSync(join(targetDir, 'wrangler.jsonc'), wranglerOut);

    // 6. Write local dev secrets (gitignored) so `wrangler dev` works at once.
    //    Required values are filled in; auth-provider credentials are left as
    //    commented placeholders to enable (each provider is configured in
    //    src/index.ts via the createStartupAPI factory). See .dev.vars.example.
    const devVars =
      `# Local development secrets for \`wrangler dev\` (gitignored).\n` +
      `SESSION_SECRET="${sessionSecret}"\n` +
      `ORIGIN_URL="${origin}"\n` +
      `\n` +
      `# Uncomment and fill in to enable an auth provider (configured in src/index.ts):\n` +
      `# GOOGLE_CLIENT_ID=""\n` +
      `# GOOGLE_CLIENT_SECRET=""\n` +
      `# TWITCH_CLIENT_ID=""\n` +
      `# TWITCH_CLIENT_SECRET=""\n` +
      `# PATREON_CLIENT_ID=""\n` +
      `# PATREON_CLIENT_SECRET=""\n`;
    writeFileSync(join(targetDir, '.dev.vars'), devVars);

    // 7. Install dependencies (runs the project's sync-assets postinstall) --
    let installed = false;
    if (args.install) {
      console.log(`${dim('Installing dependencies with npm…')}\n`);
      const res = spawnSync('npm', ['install'], { cwd: targetDir, stdio: 'inherit' });
      installed = res.status === 0;
      if (!installed) {
        console.log(`\n${red('npm install failed')} — you can run it manually below.`);
      }
    }

    // 8. Next steps ---------------------------------------------------------
    const rel = projectName;
    console.log(`\n${green('✔')} ${bold('Created your Startup API project!')}\n`);
    console.log(`  Origin (proxied to): ${cyan(origin)}\n`);
    console.log(bold('  Next steps:\n'));
    console.log(`    cd ${rel}`);
    if (!installed) console.log('    npm install');
    console.log(`    npm run dev            ${dim('# local dev at http://localhost:8787')}`);
    console.log('');
    console.log(`    npm run deploy         ${dim('# deploy to Cloudflare')}`);
    console.log(
      `    npx wrangler secret put SESSION_SECRET   ${dim('# set the production session secret')}`,
    );
    console.log(
      `\n  ${dim('Add provider credentials (GOOGLE/TWITCH/PATREON) to')} ${cyan('.dev.vars')}${dim(' and tune')}\n` +
        `  ${dim('auth behavior in')} ${cyan('src/index.ts')}${dim('. See')} ${cyan('README.md')}.\n`,
    );
  } finally {
    rl?.close();
  }
}

main().catch((err) => fail(err?.stack || String(err)));
