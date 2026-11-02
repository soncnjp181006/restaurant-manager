// Compat test: sync-service's own SHOW CHANGES parsing against dbproxy.
// Mirrors what sync-manager.tailTable() does after the PostgreSQL switch.
const path = require('node:path'); const { pathToFileURL } = require('node:url');
const helpersPath = path.resolve('..', 'sync-service', 'src', 'sync-helpers.js');

(async () => {
  const { Surreal, RecordId } = await import('surrealdb');
  const helpers = await import(new URL(pathToFileURL(helpersPath)).href);

  const db = new Surreal();
  await db.connect('ws://127.0.0.1:8007/rpc', {
    namespace: 'restaurant_manager',
    database: 'restaurant_manager',
    authentication: { username: 'restaurant', password: 'fc3ec04f8907d7032df738bae6951b928d83' },
  });

  let failures = 0;
  const check = (name, pass, extra = '') => {
    console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${extra ? ` (${extra})` : ''}`);
    if (!pass) failures += 1;
  };

  // fresh slice of change history for this table
  await db.query('DELETE sync_test_order');
  const before = await db.query('SHOW CHANGES FOR TABLE sync_test_order SINCE 0 LIMIT 1000');
  void before;

  const created = await db.create(new RecordId('sync_test_order', 'o1')).content({ status: 'open', total: 10 });
  await db.update(new RecordId('sync_test_order', 'o1')).merge({ total: 20 });
  void created;

  const result = await db.query('SHOW CHANGES FOR TABLE sync_test_order SINCE 0 LIMIT 1000');
  const entries = helpers.normalizeShowChangesResult(result);
  check('normalizeShowChangesResult returns entries', entries.length >= 2, `n=${entries.length}`);

  const { operations, lastVersionstamp } = helpers.compactChangeBatch(entries);
  const o1 = operations.find((op) => helpers.recordIdKey(op.recordId) === 'sync_test_order:o1');
  check('upsert operation found for o1', Boolean(o1));
  check('upsert value has net total 20', o1 && o1.value && o1.value.total === 20);
  check('upsert action is UPSERT', o1 && o1.action === 'UPSERT');
  check('lastVersionstamp present', lastVersionstamp != null);

  // cursor semantics: entriesAfterCursor drops entries at/before the cursor
  const after = helpers.entriesAfterCursor(entries, lastVersionstamp);
  check('entriesAfterCursor drops replayed entries', after.length === 0);

  // delete → DELETE op with recordId
  await db.delete(new RecordId('sync_test_order', 'o1'));
  const result2 = await db.query(`SHOW CHANGES FOR TABLE sync_test_order SINCE ${String(lastVersionstamp)} LIMIT 100`);
  const entries2 = helpers.normalizeShowChangesResult(result2);
  const { operations: ops2 } = helpers.compactChangeBatch(entries2);
  const del = ops2.find((op) => helpers.recordIdKey(op.recordId) === 'sync_test_order:o1');
  check('DELETE operation parsed', Boolean(del) && del.action === 'DELETE', del ? del.action : 'missing');

  // watermark read path (readFeedWatermark shape)
  const wm = entries2.length ? entries2[entries2.length - 1].versionstamp : null;
  check('watermark comparable via BigInt', wm != null && !Number.isNaN(BigInt(wm)));

  await db.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
