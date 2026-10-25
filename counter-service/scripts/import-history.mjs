import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { localConfig, requireLocalConfig, runWrangler, parseJsonOutput, fail } from './common.mjs';

const quote = value => "'" + value.replaceAll("'", "''") + "'";

export function historySql({ pv, since, asOf, uvSince }) {
  if (!Number.isSafeInteger(pv) || pv < 0) throw new Error('Historical PV must be a verified non-negative safe integer.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) ||
      new Date(since + 'T00:00:00.000Z').toISOString().slice(0, 10) !== since) throw new Error('A valid historical start date is required.');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(asOf) || !Number.isFinite(Date.parse(asOf))) throw new Error('A verified snapshot timestamp is required.');
  if (typeof uvSince !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(uvSince) || !Number.isFinite(Date.parse(uvSince))) {
    throw new Error('The new backend UV start timestamp is required.');
  }
  const snapshotTime = new Date(asOf).toISOString();
  return `INSERT INTO site_stats(site_id,history_pv,history_source,history_as_of,counting_since,uv_counting_since,epoch,updated_at)
    VALUES('rui-chen-homepage',${pv},'busuanzi.cc',${quote(snapshotTime)},${quote(since + 'T00:00:00.000Z')},
      (SELECT COALESCE(MIN(uv_counting_since),${quote(new Date(uvSince).toISOString())}) FROM site_stats),${quote(randomUUID())},${quote(snapshotTime)})
    ON CONFLICT(site_id) DO UPDATE SET history_pv=excluded.history_pv,history_source=excluded.history_source,
      history_as_of=excluded.history_as_of,counting_since=excluded.counting_since,epoch=excluded.epoch
    WHERE site_stats.pv=0 AND site_stats.uv=0 AND site_stats.history_source IS NULL;`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = requireLocalConfig();
    const args = process.argv.slice(2);
    const value = key => args[args.indexOf(key) + 1];
    if (!['--pv', '--since', '--as-of'].every(key => args.includes(key))) {
      throw new Error('Use --pv VERIFIED_NUMBER --since YYYY-MM-DD --as-of SNAPSHOT_ISO_TIMESTAMP before homepage activation.');
    }
    const sql = historySql({ pv: Number(value('--pv')), since: value('--since'), asOf: value('--as-of'),
      uvSince: config.vars.SITE_STARTED_AT });
    const results = parseJsonOutput(runWrangler(['d1', 'execute', 'DB', '--remote', '--config', localConfig,
      '--command', sql, '--json'], { quiet: true }));
    if (results[0]?.meta?.changes !== 1) throw new Error('No history was imported: this site has already received visits or has an imported baseline.');
    console.log(`Historical PV baseline imported into ${config.name}; UV was not imported. Keep the original timestamped snapshot privately.`);
  } catch (error) { fail(error); }
}
