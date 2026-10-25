import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root, localConfig, requireLocalConfig, runWrangler, writePrivateJson, fail } from './common.mjs';
import { verifyBackup } from './verify-backup.mjs';

try {
  const config = requireLocalConfig();
  const directory = path.join(root, 'private-backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = new Date().toISOString().replace(/[:.]/g, '-') + '.sql';
  const file = path.join(directory, filename);
  // Wrangler prints a signed download URL. Keep it out of application/job logs.
  runWrangler(['d1', 'export', 'DB', '--remote', '--config', localConfig, '--output', file], { quiet: true });
  chmodSync(file, 0o600);
  const restored = verifyBackup(file);
  const bytes = readFileSync(file);
  writePrivateJson(file + '.manifest.json', { created_at: new Date().toISOString(),
    database_id: config.d1_databases[0].database_id, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), verified_restore: restored });
  console.log(`Private backup exported and restored in a temporary local database: ${file}`);
} catch (error) { fail(error); }
