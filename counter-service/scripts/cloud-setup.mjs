import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root, requireLocalConfig, readJson, writePrivateJson, runWrangler, parseJsonOutput, fail } from './common.mjs';

try {
  const main = requireLocalConfig();
  const identity = parseJsonOutput(runWrangler(['whoami', '--json'], { quiet: true, allowFailure: true }));
  if (!identity.loggedIn || !identity.accounts?.some(a => a.id === main.account_id)) throw new Error('Log in to the original Cloudflare account before cloud setup.');
  const source = main.d1_databases.find(d => d.binding === 'DB');
  const configPath = path.join(root, 'maintenance/wrangler.local.json');
  let config = existsSync(configPath) ? readJson(configPath) : readJson(path.join(root, 'maintenance/wrangler.jsonc'));
  if (config.account_id && config.account_id !== main.account_id) throw new Error('Maintenance account differs from the original counter; no remote changes made.');
  const savedSource = config.d1_databases?.find(d => d.binding === 'SOURCE_DB');
  if (savedSource?.database_id && savedSource.database_id !== '00000000-0000-0000-0000-000000000000' && savedSource.database_id !== source.database_id) throw new Error('The source database differs from the recorded maintenance binding.');
  config.account_id = main.account_id;
  config.services = [{ binding: 'COUNTER_SERVICE', service: main.name }];
  const oldArchive = config.d1_databases?.find(d => d.binding === 'ARCHIVE_DB');
  config.d1_databases = [{ binding: 'SOURCE_DB', database_name: source.database_name, database_id: source.database_id }, ...(oldArchive ? [oldArchive] : [])];
  writePrivateJson(configPath, config);
  const databases = parseJsonOutput(runWrangler(['d1', 'list', '--json', '--config', configPath], { quiet: true }));
  if (!databases.some(d => d.uuid === source.database_id && d.name === source.database_name)) throw new Error('The original source database could not be verified.');
  const recorded = oldArchive?.database_id && oldArchive.database_id !== '00000000-0000-0000-0000-000000000000';
  if (recorded && !databases.some(d => d.uuid === oldArchive.database_id && d.name === 'rui-chen-counter-backups')) throw new Error('The recorded archive database could not be verified.');
  if (!recorded && databases.some(d => d.name === 'rui-chen-counter-backups')) throw new Error('Archive database name already exists. Restore its local configuration; do not adopt it automatically.');
  const secretPath = path.join(root, 'private-secrets/maintenance-secret.txt');
  if (recorded && !existsSync(secretPath)) throw new Error('Restore the original maintenance secret before changing the existing cloud task.');
  mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  if (readFileSync(secretPath, 'utf8').trim().length < 32) throw new Error('Invalid private maintenance secret.');
  if (!recorded) {
    config.d1_databases = config.d1_databases.filter(d => d.binding !== 'ARCHIVE_DB');
    writePrivateJson(configPath, config);
    runWrangler(['d1', 'create', 'rui-chen-counter-backups', '--location', 'weur', '--binding', 'ARCHIVE_DB', '--update-config', '--config', configPath]);
    config = readJson(configPath);
  }
  const archive = config.d1_databases.find(d => d.binding === 'ARCHIVE_DB');
  if (!archive?.database_id || archive.database_id === source.database_id) throw new Error('An independent archive database is required.');
  archive.migrations_dir = 'migrations';
  writePrivateJson(configPath, config);
  runWrangler(['d1', 'migrations', 'apply', 'ARCHIVE_DB', '--remote', '--config', configPath]);
  console.log('Independent cloud archive prepared. Original counter database was not modified.');
} catch (error) { fail(error); }
