// One-off: delete Storage images for the 17 purged test boutiques.
// SQL can't delete storage.objects (protect_delete trigger), so this uses the
// Storage API with the SERVICE ROLE key.
//
// It reads SUPABASE_URL / VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
// the repo-root .env automatically (or from real env vars if already set).
//
// Dry run (lists, deletes nothing):
//   node supabase/scripts/purge_test_storage.mjs --dry
// For real:
//   node supabase/scripts/purge_test_storage.mjs
//
// Safe to re-run; it only touches paths under the 17 boutique-id prefixes.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load repo-root .env (../../ from this file) without needing the dotenv package.
function loadEnv() {
  try {
    const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* no .env — fall back to real env vars */ }
}
loadEnv();

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry') || process.env.DRY_RUN === '1';

if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env or env).');
  process.exit(1);
}
console.log(`Target: ${URL}${DRY ? '  [DRY RUN]' : ''}`);

const BOUTIQUE_IDS = [
  'e34f3a8c-36ab-4588-984c-506d573b72e9', '746fb836-79fa-44ea-bfa0-6681b8120a04',
  '39740732-d16e-4602-bd94-5681792aad74', 'a7ea7e3d-0da5-4e17-87e4-0c1ab5a4039e',
  '9f6f34b6-b5ef-40f6-8a84-b1e627895c5c', '6bed8219-074f-45d3-a37f-b23f2af82cd0',
  '60a17c53-9e11-4b58-b81f-4a311063f7ea', '4549da0b-11c2-41fc-83bc-b7e24f550495',
  'e116eb58-1602-415a-b24a-21f6c71e6779', '8ad365c1-e3a2-40ff-a628-4a5a5da69ad4',
  'f7009a67-7774-4685-b46d-8c84ed7b8d66', '21f0cb9c-9450-46e2-8425-50c8c4e00a51',
  '717c8cb5-13a3-4859-803d-a1c1ced90fc1', '820d47d2-9429-4fa3-9771-e67127a120af',
  'e43a2f13-c1e8-40db-9b0a-4b0311724eef', '4de8ed29-cd73-4145-9602-022edad4c0cc',
  'b4f457b0-7d39-491d-ba41-d8c74e893f04',
];
const BUCKETS = ['boutique-images', 'product-images', 'shipping-labels'];

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

async function walk(bucket, prefix, out) {
  let offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(bucket)
      .list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) await walk(bucket, path, out); // folder
      else out.push(path);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
}

let grandTotal = 0;
for (const bucket of BUCKETS) {
  const paths = [];
  for (const id of BOUTIQUE_IDS) await walk(bucket, id, paths);
  if (paths.length === 0) { console.log(`${bucket}: nothing to delete`); continue; }
  console.log(`${bucket}: ${paths.length} object(s)${DRY ? ' (dry run)' : ''}`);
  if (DRY) { paths.forEach(p => console.log('  ' + p)); grandTotal += paths.length; continue; }
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await sb.storage.from(bucket).remove(batch);
    if (error) throw new Error(`remove ${bucket}: ${error.message}`);
    console.log(`  deleted ${Math.min(i + 100, paths.length)}/${paths.length}`);
  }
  grandTotal += paths.length;
}
console.log(`${DRY ? 'Would delete' : 'Deleted'} ${grandTotal} object(s) across ${BUCKETS.length} buckets.`);
