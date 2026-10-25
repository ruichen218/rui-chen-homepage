import { runWrangler, fail } from './common.mjs';
try { runWrangler(['deploy', '--dry-run']); }
catch (error) { fail(error); }
