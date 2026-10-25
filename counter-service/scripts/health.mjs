import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { root, deploymentFile, readJson, writePrivateJson, fetchJson, validStats, validApiBase, fail } from './common.mjs';

const stateFile = path.join(root, '.wrangler/health-state.json');
try {
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const deployment = readJson(deploymentFile);
  const base = validApiBase(deployment.apiBase);
  const state = existsSync(stateFile) ? readJson(stateFile) : { failures: 0 };
  try {
    const health = await fetchJson(base + '/health');
    const stats = await fetchJson(base + '/v1/stats');
    if (health.ok !== true || !validStats(stats)) throw new Error('Readiness checks failed.');
    writePrivateJson(stateFile, { failures: 0, checked_at: new Date().toISOString() });
    console.log('Counter health and statistics passed; no visits were recorded by this check.');
  } catch (error) {
    const failures = state.failures + 1;
    writePrivateJson(stateFile, { failures, checked_at: new Date().toISOString() });
    if (failures >= 3) throw new Error('Counter health has failed at least three consecutive checks. Inspect the Worker and D1 account.');
    console.log(`Transient health failure (${failures}/3).`);
  }
} catch (error) { fail(error); }
