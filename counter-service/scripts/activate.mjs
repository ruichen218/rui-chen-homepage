import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, deploymentFile, readJson, fetchJson, validStats, validApiBase, requireLocalConfig, fail } from './common.mjs';

try {
  const deployment = readJson(deploymentFile);
  const config = requireLocalConfig();
  if (!deployment.verified || deployment.account_id !== config.account_id ||
      deployment.worker_name !== config.name || deployment.database_id !== config.d1_databases[0].database_id) {
    throw new Error('The verified deployment does not match this account, Worker and database. Deploy and verify again before activating.');
  }
  const apiBase = validApiBase(deployment.apiBase);
  const health = await fetchJson(apiBase + '/health');
  const stats = await fetchJson(apiBase + '/v1/stats');
  if (health.ok !== true || !validStats(stats)) throw new Error('The API is not ready; the homepage configuration was not changed.');
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(stats.counting_since));
  const value = { provider: 'self-hosted', apiBase, countingSince: date };
  writeFileSync(path.join(root, '../assets/counter-config.js'),
    '// Public configuration. No API secrets belong in this file.\nwindow.RuiCounterConfig = Object.freeze(' +
    JSON.stringify(value, null, 2) + ');\n');
  console.log('Local homepage configuration switched. Review and publish index.html plus assets/ together; verify live PV/UV before retiring the previous service.');
} catch (error) { fail(error); }
