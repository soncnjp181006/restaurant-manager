'use strict';

const fs = require('fs');
const path = require('path');

const FONT_FAMILY = 'ReceiptMono';
const LINE_H = 18;

let registered = false;

/**
 * @returns {{ regular: string[], bold: string[] }}
 */
function fontCandidates() {
  const bundled = path.join(__dirname, '..', 'node_modules', 'dejavu-fonts-ttf', 'ttf');
  return {
    regular: [
      path.join(bundled, 'DejaVuSansMono.ttf'),
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
      '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
    ],
    bold: [
      path.join(bundled, 'DejaVuSansMono-Bold.ttf'),
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
      '/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf',
    ],
  };
}

/**
 * @param {string[]} paths
 * @returns {string|null}
 */
function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

/**
 * Register bundled/system monospace fonts for node-canvas (once).
 * Alpine and other minimal images ship without Courier New — without this, text renders as □ boxes.
 * @returns {string} CSS font-family name to use in ctx.font
 */
function ensureRasterFonts() {
  if (registered) return FONT_FAMILY;

  const { registerFont } = require('canvas');
  const c = fontCandidates();
  const regular = firstExisting(c.regular);
  const bold = firstExisting(c.bold);

  if (regular) {
    registerFont(regular, { family: FONT_FAMILY, weight: 'normal', style: 'normal' });
  }
  if (bold) {
    registerFont(bold, { family: FONT_FAMILY, weight: 'bold', style: 'normal' });
  }

  if (!regular && !bold) {
    console.warn(
      '[raster] No monospace TTF found (install dejavu-fonts-ttf). Receipt text may print as boxes.'
    );
    registered = true;
    return 'monospace';
  }

  registered = true;
  return FONT_FAMILY;
}

/**
 * Font strings for receipt canvas drawing.
 * Includes Noto Sans Arabic in the stack when installed (Docker font-noto-arabic).
 * @returns {{ family: string, normal: string, bold: string, medium: string, large: string, lineH: number }}
 */
function getRasterFonts() {
  const family = ensureRasterFonts();
  const stack = `"${family}", "Noto Sans Arabic", "Noto Sans", monospace`;
  return {
    family,
    normal: `12px ${stack}`,
    bold: `bold 12px ${stack}`,
    medium: `bold 14px ${stack}`,
    large: `bold 16px ${stack}`,
    lineH: LINE_H,
  };
}

module.exports = {
  FONT_FAMILY,
  LINE_H,
  ensureRasterFonts,
  getRasterFonts,
};
