import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }});
const lines = fs.readFileSync('/tmp/p21.csv','utf8').split('\n').filter(Boolean);
const seen = new Set();
const rows = [];
for (const line of lines) {
  const parts = line.split(',');
  if (parts.length < 12) continue;
  const item = parts[0];
  if (seen.has(item)) continue;
  seen.add(item);
  const num = (s) => (s === 'NULL' || s === '' ? null : Number(s));
  const str = (s) => (s === 'NULL' || s === '' ? null : s);
  rows.push({
    item, description: str(parts[1]),
    list_price: num(parts[2]), dealer_cost: num(parts[3]),
    price_l1: num(parts[4]), price_l2: num(parts[5]), price_l3: num(parts[6]),
    price_l4: num(parts[7]), price_l5: num(parts[8]), price_showroom: num(parts[9]),
    mfg: str(parts[10]), source: 'p21_csv', updated_at: new Date().toISOString(),
  });
}
console.log('rows:', rows.length);

// fetch existing items map
const existing = new Map();
let from = 0;
while (true) {
  const { data, error } = await sb.from('price_list').select('id,item').range(from, from+999);
  if (error) throw error;
  if (!data.length) break;
  for (const r of data) existing.set(r.item, r.id);
  from += data.length;
  if (data.length < 1000) break;
}
console.log('existing:', existing.size);

const toUpdate = [], toInsert = [];
for (const r of rows) {
  const id = existing.get(r.item);
  if (id) toUpdate.push({ id, ...r });
  else toInsert.push(r);
}
console.log('update:', toUpdate.length, 'insert:', toInsert.length);

const chunk = (arr, n) => Array.from({length: Math.ceil(arr.length/n)}, (_,i)=>arr.slice(i*n,(i+1)*n));

for (const batch of chunk(toUpdate, 500)) {
  const { error } = await sb.from('price_list').upsert(batch, { onConflict: 'id' });
  if (error) { console.error('upd err', error); process.exit(1); }
  process.stdout.write('.');
}
console.log('\nupdates done');
for (const batch of chunk(toInsert, 500)) {
  const { error } = await sb.from('price_list').insert(batch);
  if (error) { console.error('ins err', error); process.exit(1); }
  process.stdout.write('+');
}
console.log('\ninserts done');
