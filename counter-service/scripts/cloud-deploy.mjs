import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root, readJson, writePrivateJson, requireLocalConfig, runWrangler, validApiBase, fail } from './common.mjs';

try {
  const main = requireLocalConfig();
  const configPath = path.join(root, 'maintenance/wrangler.local.json');
  const config = readJson(configPath);
  const source = config.d1_databases?.find(d => d.binding === 'SOURCE_DB');
  const archive = config.d1_databases?.find(d => d.binding === 'ARCHIVE_DB');
  if (config.services?.find(s => s.binding === 'COUNTER_SERVICE')?.service !== main.name) throw new Error('Run cloud setup to configure the verified counter service binding.');
  if (config.account_id !== main.account_id || source?.database_id !== main.d1_databases.find(d => d.binding === 'DB')?.database_id || !archive?.database_id || archive.database_id === source.database_id || archive.database_id === '00000000-0000-0000-0000-000000000000') throw new Error('Cloud maintenance bindings do not match the verified setup.');
  const secret = readFileSync(path.join(root, 'private-secrets/maintenance-secret.txt'), 'utf8').trim();
  if (secret.length < 32) throw new Error('Invalid private maintenance secret.');
  const output = runWrangler(['deploy', '--keep-vars', '--config', configPath]);
  runWrangler(['secret', 'put', 'MAINTENANCE_SECRET', '--config', configPath], { input: secret + '\n' });
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/g) || [];
  if (!urls.length) throw new Error('Cloud deployment returned no workers.dev address.');
  const apiBase = validApiBase(urls.at(-1));
  writePrivateJson(path.join(root, 'maintenance/deployment.local.json'), { apiBase, account_id: config.account_id, source_database_id: source.database_id, archive_database_id: archive.database_id, deployed_at: new Date().toISOString() });
  console.log('Cloud maintenance deployed. Bootstrap and restore-check a real archive before retiring the local schedule.');
} catch (error) { fail(error); }
