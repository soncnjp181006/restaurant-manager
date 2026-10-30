'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { printerLockKey, withPrinterLock } = require('./printer-queue');

test('printerLockKey distinguishes network hosts and usb vids', () => {
  assert.equal(
    printerLockKey({ type: 'network', ip: '10.0.0.5', port: 9100 }),
    printerLockKey({ type: 'network', ip: '10.0.0.5', port: '9100' })
  );
  assert.notEqual(
    printerLockKey({ type: 'network', ip: '10.0.0.5' }),
    printerLockKey({ type: 'network', ip: '10.0.0.6' })
  );
  assert.equal(
    printerLockKey({ type: 'usb', vid: 0x04b8, pid: 0x0e15 }),
    'usb:1208:3605:'
  );
});

test('withPrinterLock serializes jobs for the same printer', async () => {
  const order = [];
  const printer = { type: 'network', ip: '192.168.1.50', port: 9100 };

  const job = (label, ms) =>
    withPrinterLock(printer, async () => {
      order.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end:${label}`);
      return label;
    });

  const [a, b] = await Promise.all([job('a', 40), job('b', 10)]);
  assert.equal(a, 'a');
  assert.equal(b, 'b');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('withPrinterLock allows different printers in parallel', async () => {
  const events = [];
  const p1 = { type: 'network', ip: '10.0.0.1' };
  const p2 = { type: 'network', ip: '10.0.0.2' };

  await Promise.all([
    withPrinterLock(p1, async () => {
      events.push('1s');
      await new Promise((r) => setTimeout(r, 30));
      events.push('1e');
    }),
    withPrinterLock(p2, async () => {
      events.push('2s');
      await new Promise((r) => setTimeout(r, 5));
      events.push('2e');
    }),
  ]);

  assert.ok(events.indexOf('2e') < events.indexOf('1e'));
  assert.equal(events[0], '1s');
  assert.equal(events[1], '2s');
});
