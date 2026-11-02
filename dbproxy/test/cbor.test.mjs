import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cborEncode,
  cborDecode,
  SRid,
  SDateTime,
  SUuid,
  SDecimal,
  SDuration,
  STable,
  SSet,
  SNone,
  STagged,
} from '../src/cbor.mjs';

test('round-trips plain scalars', () => {
  for (const v of [null, true, false, 0, 1, -1, 23, 24, 255, 256, 65535, 65536, 4294967295, 1.5, -0.25, 'hello', '', 'tiếng Việt 🍜']) {
    assert.deepEqual(cborDecode(cborEncode(v)), v);
  }
});

test('encodes undefined and NONE as tag 6', () => {
  const decodedUndefined = cborDecode(cborEncode(undefined));
  const decodedNone = cborDecode(cborEncode(new SNone()));
  assert.ok(decodedUndefined instanceof SNone);
  assert.ok(decodedNone instanceof SNone);
});

test('round-trips containers', () => {
  const v = { a: [1, 2, { b: 'x' }], c: { d: null }, e: [] };
  assert.deepEqual(cborDecode(cborEncode(v)), v);
});

test('round-trips byte strings', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(cborDecode(cborEncode(bytes)), bytes);
});

test('Date encodes as custom datetime and decodes to SDateTime', () => {
  const date = new Date('2026-11-02T03:04:05.678Z');
  const out = cborDecode(cborEncode(date));
  assert.ok(out instanceof SDateTime);
  assert.equal(out.iso, date.toISOString());
  // SDK accepts tag 12 [secs, nsecs] — verify payload shape (tag 12 => 0xCC)
  const raw = cborEncode(date);
  assert.equal(raw[0], 0xcc);
});

test('SRid encodes as tag 8 array form', () => {
  const out = cborDecode(cborEncode(new SRid('order', 'abc-123')));
  assert.ok(out instanceof SRid);
  assert.equal(out.table, 'order');
  assert.equal(out.id, 'abc-123');
  assert.equal(out.toString(), 'order:abc-123');
});

test('plain rid-shaped strings stay plain strings on the wire', () => {
  // Only tag-8 wrapped values become RecordId/StringRecordId on the SDK side;
  // a plain CBOR string must arrive as a string.
  const asString = 'order:⟨does-not⟩';
  const back = cborDecode(cborEncode(asString));
  assert.equal(back, asString);
});

test('SDateTime encodes to tag 12 [secs, nsecs]', () => {
  const bytes = cborEncode(new SDateTime('2026-11-02T00:00:01.5Z'));
  // tag 12 = 0xCC
  assert.equal(bytes[0], 0xcc);
  const out = cborDecode(bytes);
  assert.equal(out.iso, '2026-11-02T00:00:01.500Z');
});

test('SUuid encodes as tag 37 with 16 raw bytes', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const bytes = cborEncode(new SUuid(id));
  assert.equal(bytes[0], 0xd8 | 0); // tag with 1-byte arg
  assert.equal(bytes[1], 37);
  const out = cborDecode(bytes);
  assert.ok(out instanceof SUuid);
  assert.equal(out.str, id);
});

test('SDecimal / SDuration / STable / SSet round-trip', () => {
  const dec = cborDecode(cborEncode(new SDecimal('12.345678901234567890123456789')));
  assert.ok(dec instanceof SDecimal);
  assert.equal(dec.str, '12.345678901234567890123456789');

  const dur = cborDecode(cborEncode(new SDuration('1w2d3h')));
  assert.ok(dur instanceof SDuration);
  assert.equal(dur.str, '1w2d3h');

  const tbl = cborDecode(cborEncode(new STable('order')));
  assert.ok(tbl instanceof STable);
  assert.equal(tbl.name, 'order');

  const set = cborDecode(cborEncode(new SSet([1, 2, 3])));
  assert.ok(set instanceof SSet);
  assert.deepEqual(set.items, [1, 2, 3]);
});

test('unknown tags pass through as STagged', () => {
  const out = cborDecode(cborEncode(new STagged(88, [[1, 2]])));
  assert.ok(out instanceof STagged);
  assert.equal(out.tag, 88);
  assert.deepEqual(out.value, [[1, 2]]);
});

test('nested surreal values inside containers', () => {
  const row = {
    id: new SRid('dish', 'pho'),
    created_at: new SDateTime('2026-01-01T00:00:00Z'),
    items: [new SRid('inventory_item', 'beef')],
    meta: { none: new SNone() },
  };
  const out = cborDecode(cborEncode(row));
  assert.ok(out.id instanceof SRid);
  assert.ok(out.created_at instanceof SDateTime);
  assert.ok(out.items[0] instanceof SRid);
  assert.ok(out.meta.none instanceof SNone);
});

test('big integers survive as 64-bit', () => {
  const big = 4294967296; // > uint32, < 2^53
  assert.equal(cborDecode(cborEncode(big)), big);
  const bigNeg = -4294967296;
  assert.equal(cborDecode(cborEncode(bigNeg)), bigNeg);
});
