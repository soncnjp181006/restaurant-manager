'use strict';

const { PRINTER_WIDTH } = require('./receipt-helpers');
const { ensureRasterFonts } = require('./raster-fonts');

/** ESC/POS Font A default cell size in dots. */
const FONT_A_WIDTH_DOTS = 12;
const FONT_A_HEIGHT_DOTS = 24;
/** Typical default line spacing on thermal firmware (~30 dots). */
const LINE_HEIGHT_DOTS = 30;
/** Fine-tune raster text vs ESC/POS Font A (negative = smaller). */
const RASTER_FONT_SIZE_ADJUST_PX = -5;

/**
 * @param {Object} metrics
 * @returns {Object}
 */
function applyFontSizeAdjust(metrics) {
  const normalFontPx = Math.max(8, metrics.normalFontPx + RASTER_FONT_SIZE_ADJUST_PX);
  const lineHeightNormal = Math.max(
    normalFontPx + 2,
    metrics.lineHeightNormal + RASTER_FONT_SIZE_ADJUST_PX
  );
  return {
    ...metrics,
    normalFontPx,
    lineHeightNormal,
    lineHeightMedium: lineHeightNormal,
    lineHeightLarge: Math.round(lineHeightNormal * 2),
  };
}

/**
 * Derive canvas font metrics from printable paper width so raster text matches ESC/POS scale.
 * @param {number} paperWidthPx
 * @returns {Object}
 */
function getRasterMetrics(paperWidthPx) {
  const paper = Math.max(8, Math.ceil(Number(paperWidthPx) / 8) * 8);
  const charWidthPx = paper / PRINTER_WIDTH;
  const normalFontPx = Math.max(
    10,
    Math.round(charWidthPx * (FONT_A_HEIGHT_DOTS / FONT_A_WIDTH_DOTS))
  );
  const lineHeightNormal = Math.max(
    normalFontPx + 2,
    Math.round(charWidthPx * (LINE_HEIGHT_DOTS / FONT_A_WIDTH_DOTS))
  );
  return {
    paperWidthPx: paper,
    printerWidth: PRINTER_WIDTH,
    charWidthPx,
    normalFontPx,
    lineHeightNormal,
    lineHeightMedium: lineHeightNormal,
    lineHeightLarge: Math.round(lineHeightNormal * 2),
    scaleMedium: 2,
    scaleLarge: 2,
  };
}

/**
 * Tune font px so monospace glyphs span the full printable width (42 cols).
 * @param {Object} metrics
 * @param {CanvasRenderingContext2D} ctx
 * @returns {Object}
 */
function calibrateMetrics(metrics, ctx) {
  const family = ensureRasterFonts();
  let size = metrics.normalFontPx;
  ctx.font = buildCtxFont(false, size, family);
  const charW = ctx.measureText('M').width || 1;
  const target = metrics.paperWidthPx / metrics.printerWidth;
  if (Math.abs(charW - target) / target > 0.04) {
    size = Math.max(10, Math.round(size * (target / charW)));
  }
  const lineHeightNormal = Math.max(
    size + 2,
    Math.round((metrics.paperWidthPx / metrics.printerWidth) * (LINE_HEIGHT_DOTS / FONT_A_WIDTH_DOTS))
  );
  return applyFontSizeAdjust({
    ...metrics,
    normalFontPx: size,
    lineHeightNormal,
    lineHeightMedium: lineHeightNormal,
    lineHeightLarge: Math.round(lineHeightNormal * 2),
  });
}

/**
 * @param {boolean} bold
 * @param {number} px
 * @param {string} family
 * @returns {string}
 */
function buildCtxFont(bold, px, family) {
  const weight = bold ? 'bold ' : '';
  return `${weight}${px}px "${family}", "Noto Sans Arabic", "Noto Sans", monospace`;
}

module.exports = {
  FONT_A_WIDTH_DOTS,
  FONT_A_HEIGHT_DOTS,
  LINE_HEIGHT_DOTS,
  RASTER_FONT_SIZE_ADJUST_PX,
  getRasterMetrics,
  calibrateMetrics,
  buildCtxFont,
};
