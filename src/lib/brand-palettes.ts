import type { AppBrandId, AppBrandPresetId, BrandPalette, ResolvedAppTheme } from '@/lib/theme.ts';
import {
  deriveBrandPaletteFromBase,
  normalizeCustomBase,
  type CustomPaletteBase,
} from '@/lib/derive-brand-palette.ts';

/**
 * Every preset is cold (hue band ~180-260). Status colors stay semantic —
 * warning is still amber, danger still red — but each is tuned to sit on a
 * blue-tinted surface instead of a warm one.
 *
 * `classic` is the app default and the fallback for `custom` and for unknown
 * brand ids stored on disk, so recoloring it (rather than renaming it) is what
 * turns an existing install cold without a data migration.
 */
const classicLight: BrandPalette = {
  canvas: '226 234 243',
  surface: '243 246 251',
  surfaceElevated: '255 255 255',
  foreground: '22 34 48',
  muted: '88 108 130',
  border: '206 218 231',
  primary: '14 116 144',
  primaryFg: '255 255 255',
  warning: '180 83 9',
  danger: '190 18 60',
  success: '13 148 136',
  info: '2 132 199',
};

const classicDark: BrandPalette = {
  canvas: '8 12 18',
  surface: '15 22 32',
  surfaceElevated: '24 33 46',
  foreground: '226 236 245',
  muted: '147 167 186',
  border: '41 55 73',
  primary: '34 211 238',
  primaryFg: '6 20 28',
  warning: '251 191 36',
  danger: '251 113 133',
  success: '52 211 153',
  info: '56 189 248',
};

const oceanLight: BrandPalette = {
  canvas: '205 232 238',
  surface: '238 248 251',
  surfaceElevated: '255 255 255',
  foreground: '12 46 60',
  muted: '66 108 124',
  border: '186 220 230',
  // #0D9488 left white button text at 3.74:1; cyan-700 clears 4.5:1.
  primary: '14 116 144',
  primaryFg: '255 255 255',
  warning: '180 83 9',
  danger: '190 18 60',
  success: '15 118 110',
  info: '2 132 199',
};

const oceanDark: BrandPalette = {
  canvas: '6 20 28',
  surface: '12 30 40',
  surfaceElevated: '20 44 56',
  foreground: '220 240 246',
  muted: '140 190 208',
  border: '32 66 82',
  primary: '45 212 191',
  primaryFg: '6 24 30',
  warning: '251 191 36',
  danger: '251 113 133',
  success: '52 211 153',
  info: '56 189 248',
};

const forestLight: BrandPalette = {
  canvas: '214 232 228',
  surface: '240 248 245',
  surfaceElevated: '255 255 255',
  foreground: '20 44 40',
  muted: '82 118 110',
  border: '196 220 214',
  primary: '15 118 110',
  primaryFg: '255 255 255',
  warning: '180 83 9',
  danger: '190 18 60',
  success: '13 148 136',
  info: '2 132 199',
};

const forestDark: BrandPalette = {
  canvas: '10 20 20',
  surface: '18 32 31',
  surfaceElevated: '28 47 45',
  foreground: '224 240 236',
  muted: '150 190 182',
  border: '42 70 66',
  primary: '110 231 183',
  primaryFg: '10 26 24',
  warning: '251 191 36',
  danger: '251 113 133',
  success: '110 231 183',
  info: '45 212 191',
};

const creamLight: BrandPalette = {
  canvas: '228 233 240',
  surface: '246 248 252',
  surfaceElevated: '255 255 255',
  foreground: '30 38 50',
  muted: '94 106 122',
  border: '212 219 229',
  primary: '71 85 105',
  primaryFg: '255 255 255',
  warning: '180 83 9',
  danger: '190 18 60',
  success: '15 118 110',
  info: '2 132 199',
};

const creamDark: BrandPalette = {
  canvas: '12 15 20',
  surface: '19 23 30',
  surfaceElevated: '28 34 43',
  foreground: '233 238 244',
  muted: '160 172 188',
  border: '44 52 64',
  primary: '148 163 184',
  primaryFg: '15 20 28',
  warning: '251 191 36',
  danger: '251 113 133',
  success: '52 211 153',
  info: '56 189 248',
};

const rubyLight: BrandPalette = {
  canvas: '231 228 244',
  surface: '246 245 252',
  surfaceElevated: '255 255 255',
  foreground: '38 30 66',
  muted: '96 88 130',
  border: '214 209 234',
  primary: '192 38 211',
  primaryFg: '255 255 255',
  warning: '180 83 9',
  danger: '190 18 60',
  success: '13 148 136',
  info: '2 132 199',
};

const rubyDark: BrandPalette = {
  canvas: '14 12 26',
  surface: '23 20 40',
  surfaceElevated: '33 29 56',
  foreground: '236 233 250',
  muted: '172 165 205',
  border: '54 48 84',
  primary: '232 121 249',
  primaryFg: '26 8 40',
  warning: '251 191 36',
  danger: '251 113 133',
  success: '52 211 153',
  info: '129 140 248',
};

const sapphireLight: BrandPalette = {
  canvas: '224 230 246',
  surface: '243 246 253',
  surfaceElevated: '255 255 255',
  foreground: '24 34 62',
  muted: '84 98 128',
  border: '203 212 234',
  primary: '37 99 235',
  primaryFg: '255 255 255',
  warning: '180 83 9',
  danger: '190 18 60',
  success: '13 148 136',
  info: '2 132 199',
};

const sapphireDark: BrandPalette = {
  canvas: '10 14 26',
  surface: '17 22 40',
  surfaceElevated: '26 33 55',
  foreground: '232 238 250',
  muted: '160 172 198',
  border: '46 55 82',
  primary: '96 165 250',
  primaryFg: '8 18 34',
  warning: '251 191 36',
  danger: '251 113 133',
  success: '52 211 153',
  info: '56 189 248',
};

export const BRAND_PALETTES: Record<AppBrandPresetId, Record<ResolvedAppTheme, BrandPalette>> = {
  classic: { light: classicLight, dark: classicDark },
  ocean: { light: oceanLight, dark: oceanDark },
  forest: { light: forestLight, dark: forestDark },
  cream: { light: creamLight, dark: creamDark },
  ruby: { light: rubyLight, dark: rubyDark },
  sapphire: { light: sapphireLight, dark: sapphireDark },
};

export function getBrandPalette(brand: AppBrandId, mode: ResolvedAppTheme): BrandPalette {
  if (brand === 'custom') return BRAND_PALETTES.classic[mode];
  return BRAND_PALETTES[brand]?.[mode] ?? BRAND_PALETTES.classic[mode];
}

/** A custom brand can be supplied as a legacy primary string or a 4-color base. */
export type CustomBrandInput = string | Partial<CustomPaletteBase> | null | undefined;

/**
 * Resolve preset or custom palette. Custom always goes through the four-color
 * base model (seeded from a legacy primary when needed) so achromatic inputs
 * stay neutral instead of picking up a forced-saturation tint.
 */
export function resolveBrandPalette(
  brand: AppBrandId,
  mode: ResolvedAppTheme,
  custom?: CustomBrandInput,
): BrandPalette {
  if (brand === 'custom') {
    return deriveBrandPaletteFromBase(normalizeCustomBase(custom), mode);
  }
  return getBrandPalette(brand, mode);
}
