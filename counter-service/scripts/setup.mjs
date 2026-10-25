import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root, localConfig, runWrangler, parseJsonOutput, readJson, writePrivateJson, fail } from './common.mjs';

try {
  const identity = parseJsonOutput(runWrangler(['whoami', '--json'], { quiet: true, allowFailure: true }));
  if (!identity.loggedIn) throw new Error('Cloudflare is not logged in. Run npx wrangler login, then npm run setup.');
  let config = existsSync(localConfig) ? readJson(localConfig) : readJson(path.join(root, 'wrangler.jsonc'));
  const accounts = identity.accounts || [];
  const requestedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (requestedAccount && config.account_id && requestedAccount !== config.account_id) {
    throw new Error('The configured account differs from CLOUDFLARE_ACCOUNT_ID; setup will not switch accounts.');
  }
  const account = config.account_id || requestedAccount || (accounts.length === 1 && accounts[0].id);
  if (!account || !accounts.some(item => item.id === account)) {
    throw new Error('Select one of your Cloudflare accounts explicitly with CLOUDFLARE_ACCOUNT_ID, then rerun setup.');
  }
  config.account_id = account;
  // Persist only account selection before a read-only list, so Wrangler targets
  // the selected account; no remote database or migration has changed yet.
  writePrivateJson(localConfig, config);
  const databases = parseJsonOutput(runWrangler(['d1', 'list', '--json', '--config', localConfig], { quiet: true }));
  const oldBinding = config.d1_databases?.find(item => item.binding === 'DB');
  const oldId = oldBinding?.database_id;
  const recorded = oldId && oldId !== '00000000-0000-0000-0000-000000000000';
  const existing = recorded ? databases.find(item => item.uuid === oldId) : null;
  if (recorded && (!existing || existing.name !== oldBinding.database_name)) {
    throw new Error('The recorded database is missing or belongs to a different setup. No database was changed.');
  }
  if (!recorded && databases.some(item => item.name === 'rui-chen-homepage-counter')) {
    throw new Error('A database with this name already exists. Restore its original local config and visitor secret instead of adopting it automatically.');
  }
  const directory = path.join(root, 'private-secrets');
  const secretFile = path.join(directory, 'visitor-secret.txt');
  if (existing && !existsSync(secretFile)) {
    throw new Error('The original visitor secret is missing. Restore it before setup; no migrations or remote writes were performed.');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  }
  if (!existing) {
    config.d1_databases = [];
    config.vars.SITE_STARTED_AT = new Date().toISOString();
    writePrivateJson(localConfig, config);
    runWrangler(['d1', 'create', 'rui-chen-homepage-counter', '--location', 'weur',
      '--binding', 'DB', '--update-config', '--config', localConfig]);
    config = readJson(localConfig);
  }
  const binding = config.d1_databases?.find(item => item.binding === 'DB');
  if (!binding?.database_id || binding.database_id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('D1 creation did not return a database binding.');
  }
  runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', localConfig]);
  console.log('Database and migrations prepared. Keep private-secrets backed up privately. Next: npm run deploy.');
} catch (error) { fail(error); }
