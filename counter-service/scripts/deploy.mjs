import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { root, localConfig, deploymentFile, requireLocalConfig, runWrangler,
  fetchJson, validStats, writePrivateJson, validApiBase, fail } from './common.mjs';

try {
  const config = requireLocalConfig();
  const secretFile = path.join(root, 'private-secrets/visitor-secret.txt');
  if (!existsSync(secretFile)) throw new Error('The original visitor secret is missing. Restore its private backup; do not generate a replacement for an existing site.');
  const secret = readFileSync(secretFile, 'utf8').trim();
  if (secret.length < 32) throw new Error('The private visitor secret is invalid.');
  const output = runWrangler(['deploy', '--keep-vars', '--config', localConfig]);
  // Deploy first, then upload the stable secret. The homepage is not switched here.
  runWrangler(['secret', 'put', 'VISITOR_SECRET', '--config', localConfig], { input: secret + '\n' });
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/g) || [];
  if (!urls.length) throw new Error('No workers.dev address was returned. Check the deployment and register the account subdomain in Cloudflare.');
  const apiBase = validApiBase(urls.at(-1));
  const health = await fetchJson(apiBase + '/health');
  const stats = await fetchJson(apiBase + '/v1/stats');
  if (health.ok !== true || !validStats(stats)) throw new Error('The deployed API did not pass readiness and statistics checks.');
  writePrivateJson(deploymentFile, { apiBase, database_id: config.d1_databases[0].database_id,
    account_id: config.account_id, worker_name: config.name,
    deployed_at: new Date().toISOString(), verified: true });
  console.log(`API verified: ${apiBase}. Import any verified historical PV, make a backup, then run npm run activate.`);
} catch (error) { fail(error); }
