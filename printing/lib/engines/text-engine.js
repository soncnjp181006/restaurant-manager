'use strict';

const escpos = require('escpos');
const { createDevice } = require('../../drivers');
const { getBuilder } = require('../../print-builders');

const DEFAULT_OPTIONS = { encoding: 'UTF-8', width: 42 };

/**
 * Classic ESC/POS text builders (existing behavior).
 * @param {Object} printerDriver - device config from request printers[]
 * @param {Object} escposOptions
 * @param {string} printType
 * @param {Object} data
 * @param {Object} config - effective normalized config
 * @returns {Promise<void>}
 */
async function print(printerDriver, escposOptions, printType, data, config) {
  const device = createDevice(printerDriver);
  const escposOpts = { ...DEFAULT_OPTIONS, ...escposOptions };
  const printer = new escpos.Printer(device, escposOpts);
  const configWithPrinter = {
    ...config,
    escposLineWidth: escposOpts.width,
  };

  await new Promise((resolve, reject) => {
    device.open((openErr) => {
      if (openErr) return reject(openErr);

      const builder = getBuilder(printType);
      Promise.resolve(builder.build(printer, data, configWithPrinter))
        .then(() => {
          return new Promise((res, rej) => {
            printer.close((closeErr) => (closeErr ? rej(closeErr) : res()));
          });
        })
        .then(resolve)
        .catch(reject);
    });
  });
}

module.exports = { print, DEFAULT_OPTIONS };
