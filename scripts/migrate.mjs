import { openDb } from '../src/log.mjs';
const db = await openDb();
const t = (await db.query("select table_name from information_schema.tables where table_schema='public' order by 1")).rows.map(r => r.table_name);
console.log('migrated. tables:', t.join(', '));
await db.close();
