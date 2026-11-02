// Smoke test against the dockerized stack (dbproxy on host port 8007).
const { Surreal, RecordId } = await import('surrealdb');
import bcrypt from 'bcryptjs';

const db = new Surreal();
await db.connect('ws://127.0.0.1:8007/rpc', {
  namespace: 'restaurant_manager',
  database: 'restaurant_manager',
  authentication: { username: 'restaurant', password: 'fc3ec04f8907d7032df738bae6951b928d83' },
});

const results = [];

// 1. version + CRUD
results.push(['create', (await db.create(new RecordId('smoke', 'a')).content({ name: 'x', price: 1 })).name === 'x']);
const sel = await db.select(new RecordId('smoke', 'a'));
results.push(['select + RecordId', sel.id instanceof RecordId]);

// 2. bcrypt where
const hash = bcrypt.hashSync('pw', 10);
await db.update(new RecordId('smoke', 'a')).merge({ password: hash });
const login = await db.query('SELECT * FROM smoke WHERE crypto::bcrypt::compare(password, $p) = true', { p: 'pw' });
results.push(['bcrypt where', login[0].length === 1]);

// 3. live (subscribe, then mutate, then wait for the push)
const got = [];
const live = await db.live('smoke');
const consume = (async () => { for await (const m of live) { got.push(m.action); if (got.length >= 1) break; } })().catch(() => {});
await new Promise((r) => setTimeout(r, 400));
await db.update(new RecordId('smoke', 'a')).merge({ price: 42 });
await new Promise((r) => setTimeout(r, 800));
results.push(['live push', got[0] === 'UPDATE']);
await live.kill();

// 4. datetime
await db.query('UPDATE smoke:a SET ts = time::now()');
const withTs = await db.select(new RecordId('smoke', 'a'));
const iso = withTs.ts instanceof Date ? withTs.ts.toISOString() : String(withTs.ts);
results.push(['datetime', !Number.isNaN(Date.parse(iso))]);

// 5. cleanup
await db.delete(new RecordId('smoke', 'a'));

let ok = true;
for (const [name, pass] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}`);
  if (!pass) ok = false;
}
await db.close();
process.exit(ok ? 0 : 1);
