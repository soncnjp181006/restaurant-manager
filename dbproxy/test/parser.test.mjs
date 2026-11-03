import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.mjs';

test('SELECT * FROM table', () => {
  const [s] = parse('SELECT * FROM order');
  assert.equal(s.kind, 'select');
  assert.deepEqual(s.fields, [{ t: 'star' }]);
  assert.deepEqual(s.from, [{ t: 'table', name: 'order' }]);
});

test('SELECT with WHERE/ORDER/LIMIT/START/SPLIT/FETCH (query-builder shape)', () => {
  const [s] = parse(
    "SELECT * FROM dish WHERE number = $number AND name != NONE ORDER BY position ASC LIMIT 10 START 5 SPLIT items FETCH categories, tax, items.item"
  );
  assert.equal(s.kind, 'select');
  assert.deepEqual(s.limit, { t: 'lit', v: 10 });
  assert.ok(s.where);
  assert.deepEqual(s.split.map((p) => p.parts), [['items']]);
  assert.equal(s.order.length, 1);
  assert.equal(s.order[0].dir, 'asc');
  assert.deepEqual(s.fetch.map((p) => p.parts), [['categories'], ['tax'], ['items', 'item']]);
});

test('SELECT with LIMIT literal', () => {
  const [s] = parse('SELECT id FROM user WHERE code = $code LIMIT 1');
  assert.deepEqual(s.limit, { t: 'lit', v: 1 });
  assert.deepEqual(s.fields, [{ t: 'path', parts: ['id'] }]);
});

test('bcrypt compare in WHERE (gateway login)', () => {
  const [s] = parse(
    "SELECT * FROM user WHERE login = $login AND deleted_at = NONE AND (login_method = 'pin' OR login_method = NONE) AND crypto::bcrypt::compare(password, $password) = true FETCH user_role, user_shift"
  );
  assert.equal(s.kind, 'select');
  assert.ok(s.where.t === 'bin' && s.where.op === 'and');
  assert.deepEqual(s.fetch.map((p) => p.parts), [['user_role'], ['user_shift']]);
});

test('SELECT ONLY type::record($roleId)', () => {
  const [s] = parse('SELECT * FROM ONLY type::record($roleId) WHERE deleted_at = NONE');
  assert.equal(s.only, true);
  assert.deepEqual(s.from, [{ t: 'func', name: 'type::record', args: [{ t: 'param', name: 'roleId' }] }]);
});

test('aggregate with alias and group', () => {
  const [s] = parse('SELECT account.code, account.name, account.id, math::sum(debit - credit) AS balance FROM account_journal_line WHERE account = $account GROUP BY account FETCH account, account.group');
  assert.equal(s.group.length, 1);
  const alias = s.fields[3];
  assert.equal(alias.t, 'alias');
  assert.equal(alias.alias, 'balance');
  assert.deepEqual(alias.expr, { t: 'func', name: 'math::sum', args: [{ t: 'bin', op: '-', l: { t: 'path', parts: ['debit'] }, r: { t: 'path', parts: ['credit'] } }] });
});

test('count() without group', () => {
  const [s] = parse('SELECT count() FROM order');
  assert.deepEqual(s.fields, [{ t: 'count' }]);
});

test('CREATE table:id SET', () => {
  const [s] = parse('CREATE order:⟨does-not⟩ SET status = "In Progress", does = "hello"');
  assert.equal(s.kind, 'create');
  assert.deepEqual(s.target, { t: 'rid', table: 'order', id: 'does-not' });
  assert.equal(s.set.length, 2);
  assert.deepEqual(s.set[0][0].parts, ['status']);
});

test('UPSERT type::record($id) CONTENT $data', () => {
  const [s] = parse('UPSERT $id CONTENT $data');
  assert.equal(s.kind, 'upsert');
  assert.deepEqual(s.target, { t: 'param', name: 'id' });
});

test('UPSERT type::record(\'setting\',\'self_order\') MERGE', () => {
  const [s] = parse("UPSERT type::record('setting', 'self_order') MERGE { token: $token }");
  assert.equal(s.kind, 'upsert');
  assert.deepEqual(s.target, { t: 'func', name: 'type::record', args: [{ t: 'lit', v: 'setting' }, { t: 'lit', v: 'self_order' }] });
  assert.ok(s.merge);
});

test('UPDATE ... MERGE with time::now()', () => {
  const [s] = parse("UPDATE type::record('security_alerts', $id) MERGE { acknowledged_at: time::now() }");
  assert.equal(s.kind, 'update');
  assert.deepEqual(s.targets, [{ t: 'func', name: 'type::record', args: [{ t: 'lit', v: 'security_alerts' }, { t: 'param', name: 'id' }] }]);
  assert.equal(s.merge.t, 'obj');
  assert.deepEqual(s.merge.entries[0][1], { t: 'func', name: 'time::now', args: [] });
});

test('UPDATE table SET ... WHERE', () => {
  const [s] = parse('UPDATE user SET active = false WHERE id IN $ids');
  assert.equal(s.kind, 'update');
  assert.equal(s.where.t, 'bin');
  assert.equal(s.where.op, 'in');
});

test('DELETE FROM type::table($table) WHERE ... NOT IN', () => {
  const [s] = parse('DELETE FROM type::table($table) WHERE order = $order AND id NOT IN $ids');
  assert.equal(s.kind, 'delete');
  assert.deepEqual(s.targets, [{ t: 'func', name: 'type::table', args: [{ t: 'param', name: 'table' }] }]);
  const notIn = s.where.r;
  assert.equal(notIn.op, '!in');
});

test('DELETE type::record($id); CREATE t CONTENT $data (multi-statement)', () => {
  const stmts = parse('DELETE type::record($id); CREATE payment_webhook CONTENT $data');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0].kind, 'delete');
  assert.equal(stmts[1].kind, 'create');
});

test('INSERT variants', () => {
  const [a] = parse('INSERT INTO setting { key: "x", value: 1 };');
  assert.equal(a.kind, 'insert');
  assert.deepEqual(a.values.objs[0].entries.map(([k]) => k), ['key', 'value']);

  const [b] = parse('INSERT IGNORE INTO user [ { name: "A" }, { name: "B" } ]');
  assert.equal(b.ignore, true);
  assert.equal(b.values.objs.length, 2);

  const [c] = parse('INSERT INTO t $rows ON DUPLICATE KEY UPDATE count = count + 1');
  assert.deepEqual(c.values, { mode: 'expr', expr: { t: 'param', name: 'rows' } });
  assert.equal(c.onDuplicate.length, 1);
});

test('RELATE $dish->edge->$group', () => {
  const [s] = parse('RELATE $dish->dish_modifier_groups->$group SET quantity = 1, note = NONE');
  assert.equal(s.kind, 'relate');
  assert.equal(s.edge, 'dish_modifier_groups');
  assert.deepEqual(s.from, { t: 'param', name: 'dish' });
});

test('LIVE SELECT * FROM order WHERE ...', () => {
  const [s] = parse('LIVE SELECT * FROM order WHERE status = "In Progress"');
  assert.equal(s.kind, 'live');
  assert.deepEqual(s.from, [{ t: 'table', name: 'order' }]);
});

test('KILL u"..."', () => {
  const [s] = parse('KILL u"123e4567-e89b-12d3-a456-426614174000"');
  assert.equal(s.kind, 'kill');
  assert.equal(s.id.v, '123e4567-e89b-12d3-a456-426614174000');
});

test('SHOW CHANGES FOR TABLE order SINCE 0 LIMIT 1000', () => {
  const [s] = parse('SHOW CHANGES FOR TABLE order SINCE 0 LIMIT 1000');
  assert.equal(s.kind, 'show_changes');
  assert.deepEqual(s.since, { t: 'lit', v: 0 });
  assert.deepEqual(s.limit, { t: 'lit', v: 1000 });
});

test('DEFINE TABLE IF NOT EXISTS ... SCHEMALESS PERMISSIONS NONE', () => {
  const [s] = parse('DEFINE TABLE IF NOT EXISTS self_order_table SCHEMALESS PERMISSIONS NONE');
  assert.equal(s.kind, 'define');
  assert.equal(s.what, 'table');
  assert.equal(s.name, 'self_order_table');
});

test('DEFINE FIELD with DEFAULT time::now()', () => {
  const [s] = parse('DEFINE FIELD uploaded_at ON employee_document TYPE datetime DEFAULT time::now() PERMISSIONS FULL');
  assert.equal(s.what, 'field');
  assert.equal(s.table, 'employee_document');
  assert.deepEqual(s.default, { t: 'func', name: 'time::now', args: [] });
});

test('DEFINE INDEX ... FIELDS code UNIQUE', () => {
  const [s] = parse('DEFINE INDEX account_code_store_unique ON account FIELDS code UNIQUE');
  assert.equal(s.what, 'index');
  assert.equal(s.unique, true);
  assert.deepEqual(s.fields, ['code']);
});

test('DEFINE EVENT with WHEN/THEN', () => {
  const sql = "DEFINE EVENT audit_user_update ON user WHEN $event == 'UPDATE' THEN { CREATE audit_log CONTENT { table_name: 'user', record_id: <string> $after.id, changed_fields: <array<string>> object::keys($after) } }";
  const [s] = parse(sql);
  assert.equal(s.what, 'event');
  assert.equal(s.table, 'user');
  assert.equal(s.then.length, 1);
  assert.equal(s.then[0].kind, 'create');
});

test('DEFINE TABLE ... CHANGEFEED 14d (sync-service)', () => {
  const [s] = parse('ALTER TABLE catalog_release CHANGEFEED 14d');
  assert.equal(s.kind, 'alter');
  assert.equal(s.name, 'catalog_release');
});

test('INFO FOR DB / USE NS / RETURN 1 / LET', () => {
  const [a] = parse('INFO FOR DB');
  assert.equal(a.kind, 'info');
  assert.equal(a.scope, 'db');
  const [b] = parse('USE NS restaurant_manager DB restaurant_manager');
  assert.equal(b.ns, 'restaurant_manager');
  assert.equal(b.db, 'restaurant_manager');
  const [c] = parse('RETURN 1');
  assert.deepEqual(c.expr, { t: 'lit', v: 1 });
  const [d] = parse('LET $x = 5');
  assert.equal(d.name, 'x');
});

test('sync snapshot query (gateway sync-service)', () => {
  const [s] = parse(
    'SELECT * FROM type::table($table) WHERE updated_at > time::now() - 3d ORDER BY id ASC LIMIT $limit FETCH payments, items, items.taxes'
  );
  assert.deepEqual(s.from, [{ t: 'func', name: 'type::table', args: [{ t: 'param', name: 'table' }] }]);
  assert.deepEqual(s.limit, { t: 'param', name: 'limit' });
  assert.ok(s.where.t === 'bin');
});

test('math::max + time::unix + GROUP ALL (sync cursor)', () => {
  const [s] = parse('SELECT math::max(time::unix(updated_at)) AS max_unix FROM sync_event GROUP ALL');
  assert.equal(s.group, 'all');
  assert.equal(s.fields[0].alias, 'max_unix');
});

test('SELECT * FROM ONLY $account FETCH group', () => {
  const [s] = parse('SELECT * FROM ONLY $account FETCH group');
  assert.equal(s.only, true);
  assert.deepEqual(s.from, [{ t: 'param', name: 'account' }]);
});

test('casts <string> and <array<string>>', () => {
  const [s] = parse('SELECT <string> id, <array<string>> tags FROM t');
  assert.equal(s.fields[0].t, 'cast');
  assert.equal(s.fields[0].type, 'string');
  assert.equal(s.fields[1].type, 'array<string>');
});

test('time::now() - 3d in WHERE and INSIDE operator', () => {
  const [s] = parse('SELECT * FROM t WHERE created_at > time::now() - 3d AND location INSIDE $locations');
  assert.ok(s.where);
});

test('WHERE menu.name lowercase CONTAINS (reports)', () => {
  const [s] = parse('SELECT * FROM menu WHERE string::lowercase(menu.name) CONTAINS $menuName');
  assert.ok(s.where.t === 'bin' && s.where.op === 'contains');
});

test('duration arithmetic parses', () => {
  const [s] = parse('SELECT * FROM t WHERE updated_at > time::now() - 1w2d3h');
  const r = s.where.r; // the '-' node: time::now() - 1w2d3h
  assert.equal(r.t, 'bin');
  assert.equal(r.op, '-');
  assert.equal(r.r.ms, (9 * 24 + 3) * 3600 * 1000);
});

test('comments and multi statements', () => {
  const stmts = parse(`
    -- leading comment
    SELECT * FROM t; /* inline */ UPDATE t SET x = 1;
  `);
  assert.equal(stmts.length, 2);
});

test('field named value and order table', () => {
  const [s] = parse('SELECT value FROM setting WHERE key = $key LIMIT 1');
  assert.deepEqual(s.fields, [{ t: 'path', parts: ['value'] }]);
  assert.deepEqual(s.where.l, { t: 'path', parts: ['key'] });

  const [u] = parse('SELECT * FROM order WHERE order = $order AND id NOT IN $ids');
  assert.deepEqual(u.from, [{ t: 'table', name: 'order' }]);
  assert.deepEqual(u.where.l.l, { t: 'path', parts: ['order'] });
});

test('compound assignment: SET x += v / x -= v (smart-menu import)', () => {
  const [s] = parse('UPDATE $group SET modifiers += $modifier');
  assert.equal(s.kind, 'update');
  assert.equal(s.set.length, 1);
  assert.deepEqual(s.set[0][0].parts, ['modifiers']);
  assert.equal(s.set[0][2], '+=');

  const [c] = parse("CREATE dish:pho SET tags += 'a', nums -= 2, name = 'x'");
  assert.deepEqual(
    c.set.map(([path, , op]) => [path.parts, op]),
    [[['tags'], '+='], [['nums'], '-='], [['name'], '=']]
  );

  // plain '=' still parses to op '=' (third element present for all assignments)
  const [p] = parse('UPDATE t SET a = 1, b = 2');
  assert.deepEqual(p.set.map(([path, , op]) => [path.parts, op]), [[['a'], '='], [['b'], '=']]);
});

test('compound assignment in INSERT ON DUPLICATE KEY UPDATE', () => {
  const [s] = parse('INSERT INTO counter $rows ON DUPLICATE KEY UPDATE n += 1');
  assert.equal(s.kind, 'insert');
  assert.deepEqual(s.onDuplicate[0][0].parts, ['n']);
  assert.equal(s.onDuplicate[0][2], '+=');
});

test('RETURN BEFORE / RETURN AFTER are special modes, not paths', () => {
  const [s] = parse('UPDATE sync_event_seq:singleton SET counter += 1 RETURN BEFORE');
  assert.equal(s.return.mode, 'before');
  const [u] = parse('UPDATE t SET x = 1 RETURN AFTER');
  assert.equal(u.return.mode, 'after');
  // a path starting with a field named after/after() still parses as expression
  const [p] = parse('SELECT before FROM t');
  assert.equal(p.return, undefined);
  const [v] = parse('UPDATE t SET x = 1 RETURN after.items');
  assert.equal(v.return.mode, 'exprs');
});

test('nullish coalescing ?? inside expressions (invoice order-number)', () => {
  const [s] = parse(`UPSERT type::record('order_number_seq', $counterKey)
     SET value = math::max([value ?? 0, $seed]) + 1
     RETURN AFTER`);
  assert.equal(s.kind, 'upsert');
  assert.equal(s.return.mode, 'after');
  // SET value = (math::max([value ?? 0, $seed]) + 1) parses with ?? inside args
  assert.ok(s.set[0][1]);

  const [p] = parse('SELECT * FROM t WHERE a ?? b || c');
  // ?? binds tighter than ||
  assert.equal(p.where.op, 'or');
  assert.equal(p.where.l.op, '??');
});

test('positional INSERT INTO t (cols) VALUES (...) (Users form)', () => {
  const [s] = parse(`INSERT INTO user (first_name, login, password, user_role) VALUES ($name, $login, crypto::bcrypt::generate($pin), $role) RETURN AFTER`);
  assert.equal(s.kind, 'insert');
  const entries = s.values.objs[0].entries;
  assert.deepEqual(entries.map(([k]) => k), ['first_name', 'login', 'password', 'user_role']);
  assert.equal(entries[2][1].t, 'func');
  assert.equal(s.values.objs[0].t, 'obj');
  assert.equal(s.return.mode, 'after');
  // multi-row tuple form
  const [m] = parse('INSERT INTO t (a, b) VALUES (1, 2), (3, 4)');
  assert.equal(m.values.objs.length, 2);
  assert.deepEqual(m.values.objs[1].entries, [['a', { t: 'lit', v: 3 }], ['b', { t: 'lit', v: 4 }]]);
});
