import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.mjs';
import { evaluate, DTMarker } from '../src/eval.mjs';

// d'...' datetime literals used to hit the parser as an identifier followed by
// a string, failing with "Expected ')' but got string '…'" — the HR labor
// dashboard query `effective_to ?? d'9999-12-31T23:59:59Z'` zeroed every KPI.
test("datetime literal d'...' parses and evaluates", () => {
  const [s] = parse(
    "SELECT * FROM employee_pay_profile WHERE (effective_to ?? d'9999-12-31T23:59:59Z') >= <datetime>$startDate"
  );
  assert.ok(s.where, 'WHERE clause parsed');

  const rowNull = { effective_to: null };
  const result = evaluate(s.where, rowNull, { startDate: '2026-01-01T00:00:00Z' }, {});
  assert.equal(result, true, 'sentinel coalesce satisfies the range check');
});

test("datetime literal with double quotes d\"...\" also parses", () => {
  const [s] = parse('SELECT * FROM t WHERE created_at > d"2026-01-01T00:00:00Z"');
  const result = evaluate(s.where, { created_at: '2026-06-01T00:00:00Z' }, {}, {});
  assert.equal(result, true);
});

// Stored rows keep date_from as a plain ISO string while query params arrive
// as DTMarker; deepEqual compared representations instead of instants, so
// `WHERE date_from = $dateFrom` never matched the saved day-closing draft.
test('DTMarker param equals stored ISO datetime string', () => {
  const [s] = parse('SELECT * FROM day_closing WHERE date_from = $dateFrom');
  const param = new DTMarker('2026-11-05T23:00:00.000Z');
  assert.equal(evaluate(s.where, { date_from: '2026-11-05T23:00:00.000Z' }, { dateFrom: param }, {}), true);
  assert.equal(evaluate(s.where, { date_from: '2026-11-04T23:00:00.000Z' }, { dateFrom: param }, {}), false);
});

test('datetime equality inside IN lists', () => {
  const [s] = parse('SELECT * FROM day_closing WHERE date_from IN [$dateFrom]');
  const param = new DTMarker('2026-11-05T23:00:00.000Z');
  assert.equal(evaluate(s.where, { date_from: '2026-11-05T23:00:00.000Z' }, { dateFrom: param }, {}), true);
});

test('plain string equality is untouched by the datetime coercion', () => {
  const [s] = parse("SELECT * FROM user WHERE name = 'Admin'");
  assert.equal(evaluate(s.where, { name: 'Admin' }, {}, {}), true);
  assert.equal(evaluate(s.where, { name: 'Staff' }, {}, {}), false);
});
