import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.mjs';
import { evaluate, DTMarker } from '../src/eval.mjs';

function evalWhere(sql, row, params = {}) {
  const [s] = parse(`SELECT * FROM t WHERE ${sql}`);
  return evaluate(s.where, row, params);
}

test('comparison and boolean logic', () => {
  const row = { id: 'user:u1', login: 'anna', deleted_at: undefined, active: true, age: 30 };
  assert.equal(evalWhere('login = $login', row, { login: 'anna' }), true);
  assert.equal(evalWhere('deleted_at = NONE', row), true);
  assert.equal(evalWhere('deleted_at != NONE', row), false);
  assert.equal(evalWhere('active = true AND age > 25', row), true);
  assert.equal(evalWhere("login = 'bob' OR login = 'anna'", row), true);
  assert.equal(evalWhere('NOT (age < 25)', row), true);
});

test('bcrypt compare semantics', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const realHash = bcrypt.hashSync('s3cret', 10);
  const row = { password: realHash };
  assert.equal(evalWhere('crypto::bcrypt::compare(password, $password) = true', row, { password: 's3cret' }), true);
  assert.equal(evalWhere('crypto::bcrypt::compare(password, $password) = true', row, { password: 'wrong' }), false);
});

test('path flattening over arrays', () => {
  const row = {
    id: 'order:o1',
    items: [
      { item: 'inventory_item:beef', qty: 2 },
      { item: 'inventory_item:tofu', qty: 1 },
    ],
  };
  assert.deepEqual(evalWhere('items.item', row), ['inventory_item:beef', 'inventory_item:tofu']);
  assert.deepEqual(evalWhere('items.qty', row), [2, 1]);
});

test('INSIDE / CONTAINS / IN', () => {
  assert.equal(evalWhere('location INSIDE $locations', { location: 'loc:a' }, { locations: ['loc:a', 'loc:b'] }), true);
  assert.equal(evalWhere('location NOT INSIDE $locations', { location: 'loc:c' }, { locations: ['loc:a'] }), true);
  assert.equal(evalWhere('name CONTAINS $q', { name: 'Phở bò' }, { q: 'bò' }), true);
  assert.equal(evalWhere('id NOT IN $ids', { id: 'order:x' }, { ids: ['order:y'] }), true);
  assert.equal(evalWhere('tags CONTAINSALL $tags', { tags: ['a', 'b', 'c'] }, { tags: ['a', 'b'] }), true);
});

test('time::now() - duration in WHERE', () => {
  const now = Date.now();
  const recent = new Date(now - 1000).toISOString();
  const old = new Date(now - 10 * 24 * 3600 * 1000).toISOString();
  assert.equal(evalWhere('updated_at > time::now() - 3d', { updated_at: recent }), true);
  assert.equal(evalWhere('updated_at > time::now() - 3d', { updated_at: old }), false);
});

test('time::unix and math aggregates', () => {
  const row = { updated_at: '2026-01-02T03:04:05Z' };
  const [s] = parse('SELECT math::max(time::unix(updated_at)) AS m FROM t');
  const v = evaluate(s.fields[0].expr, row);
  assert.equal(v, Math.floor(Date.parse('2026-01-02T03:04:05Z') / 1000));
});

test('string::lowercase CONTAINS (reports filter)', () => {
  assert.equal(evalWhere('string::lowercase(menu.name) CONTAINS $menuName', { menu: { name: 'Phở Đặc Biệt' } }, { menuName: 'đặc' }), true);
});

test('time::now returns datetime marker', () => {
  const [s] = parse('SELECT time::now() AS x FROM t');
  const v = evaluate(s.fields[0].expr, {});
  assert.ok(v instanceof DTMarker);
});

test('casts', () => {
  const row = { id: 'user:u1', tags: 'a,b,c', count: '42' };
  const [s] = parse('SELECT <array<string>> tags AS t, <number> count AS n FROM t');
  const out = {};
  out.t = evaluate(s.fields[0].expr, row);
  out.n = evaluate(s.fields[1].expr, row);
  assert.deepEqual(out.t, ['a', 'b', 'c']);
  assert.equal(out.n, 42);
});

test('IF/THEN/ELSE', () => {
  const [s] = parse('SELECT (IF status = "done" THEN 1 ELSE 0 END) AS done FROM t');
  assert.equal(evaluate(s.fields[0].expr, { status: 'done' }), 1);
  assert.equal(evaluate(s.fields[0].expr, { status: 'open' }), 0);
});

test('object::keys and array::union', () => {
  const [s] = parse('SELECT array::union($a, $b) AS u, object::keys($obj) AS k FROM t');
  const params = { a: [1, 2], b: [2, 3], obj: { x: 1, y: 2 } };
  assert.deepEqual(evaluate(s.fields[0].expr, {}, params), [1, 2, 3]);
  assert.deepEqual(evaluate(s.fields[1].expr, {}, params), ['x', 'y']);
});

test('IS NONE / IS NULL distinction', () => {
  const row = { a: undefined, b: null };
  assert.equal(evalWhere('a IS NONE', row), true);
  assert.equal(evalWhere('b IS NULL', row), true);
  assert.equal(evalWhere('a IS NULL', row), false);
  assert.equal(evalWhere('b IS NOT NONE', row), true);
});
