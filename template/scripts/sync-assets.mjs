/**
 * Syncs the framework's static assets from the installed
 * `@startup-api/cloudflare` package into this project's `public/` directory so
 * Wrangler can upload them. Runs automatically on `npm install` (postinstall).
 *
 * - `public/users/**` is framework-owned and always refreshed to match the
 *   installed package version.
 * - `public/index.html` is seeded once and never overwritten, so your own
 *   landing page is preserved.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let pkgJsonPath;
try {
  pkgJsonPath = require.resolve('@startup-api/cloudflare/package.json');
} catch {
  console.warn('[sync-assets] @startup-api/cloudflare not installed yet; skipping.');
  process.exit(0);
}

const pkgRoot = dirname(pkgJsonPath);
const srcPublic = join(pkgRoot, 'public');
const destPublic = join(process.cwd(), 'public');

mkdirSync(destPublic, { recursive: true });

// Framework-owned assets: keep in lockstep with the installed package.
cpSync(join(srcPublic, 'users'), join(destPublic, 'users'), { recursive: true });

// Landing page: seed once, never clobber user customizations.
const destIndex = join(destPublic, 'index.html');
if (!existsSync(destIndex)) {
  cpSync(join(srcPublic, 'index.html'), destIndex);
}

console.log('[sync-assets] Synced framework assets into ./public');
