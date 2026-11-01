import { describe, expect, it } from 'vitest'
import { BRAND_PALETTES } from './brand-palettes.ts'
import type { BrandPalette } from './theme.ts'

/**
 * Cold-theme gate.
 *
 * Two jobs:
 *  1. Contrast — recolouring 12 palettes by hand is exactly the kind of change
 *     that quietly drops secondary text under 4.5:1.
 *  2. Hue — "no warm leftovers": every structural color (surfaces, text,
 *     accent) must sit in the cool band. Status colors (warning/danger) are
 *     deliberately excluded: amber and red are load-bearing semantics in a POS.
 *
 * Every check fails closed: an unparsable or missing channel is reported as a
 * failure, never skipped.
 */

const KEYS = [
  'canvas', 'surface', 'surfaceElevated', 'foreground', 'muted', 'border',
  'primary', 'primaryFg', 'warning', 'danger', 'success', 'info',
] as const

type Channel = { r: number; g: number; b: number }

function parseChannels(value: string | undefined, label: string): Channel {
  expect(value, `${label}: channel string is missing`).toBeTypeOf('string')
  const parts = (value as string).trim().split(/\s+/).map(Number)
  expect(parts.length, `${label}: expected "r g b", got "${value}"`).toBe(3)
  for (const n of parts) {
    expect(Number.isFinite(n), `${label}: non-numeric channel in "${value}"`).toBe(true)
    expect(n, `${label}: channel out of 0-255 range in "${value}"`).toBeGreaterThanOrEqual(0)
    expect(n, `${label}: channel out of 0-255 range in "${value}"`).toBeLessThanOrEqual(255)
  }
  return { r: parts[0], g: parts[1], b: parts[2] }
}

function toHex({ r, g, b }: Channel): string {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
}

function luminance({ r, g, b }: Channel): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function contrast(a: Channel, b: Channel): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** HSL hue in degrees plus an HSL-ish saturation, straight from the channels. */
function hueSat({ r, g, b }: Channel): { h: number; s: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const d = max - min
  if (d === 0) return { h: 0, s: 0 }
  const l = (max + min) / 2
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
  else if (max === gn) h = ((bn - rn) / d + 2) * 60
  else h = ((rn - gn) / d + 4) * 60
  return { h, s }
}

/**
 * Cool band, measured rather than guessed: the recolored presets land at
 * 156-168 (seafoam) and 293 (amethyst), while every warm value the app used to
 * ship sits at hue <= 45 or >= 340. The self-test below keeps that honest.
 */
const COOL_MIN = 150
const COOL_MAX = 320
/** Below this saturation a color is gray, which is neither warm nor cool. */
const ACHROMATIC = 0.06

const STRUCTURAL: (keyof BrandPalette)[] = [
  'canvas', 'surface', 'surfaceElevated', 'foreground', 'muted', 'border', 'primary',
]

function warmOffenders(palette: BrandPalette): string[] {
  const offenders: string[] = []
  for (const key of STRUCTURAL) {
    const ch = parseChannels(palette[key], `${key}`)
    const { h, s } = hueSat(ch)
    if (s < ACHROMATIC) continue
    if (h < COOL_MIN || h > COOL_MAX) {
      offenders.push(`${key} ${toHex(ch)} hue=${Math.round(h)} sat=${s.toFixed(2)}`)
    }
  }
  return offenders
}

const brands = Object.keys(BRAND_PALETTES)

describe('the cold gate itself', () => {
  /**
   * Negative control. A hue check that accepts everything is worse than none,
   * so the palette the app shipped before the cold refresh — cream canvas,
   * amber accent — must still be rejected by the same function.
   */
  const preColdClassic: BrandPalette = {
    canvas: '245 232 211',
    surface: '250 244 235',
    surfaceElevated: '255 255 255',
    foreground: '55 38 20',
    muted: '115 91 61',
    border: '230 211 181',
    primary: '255 165 20',
    primaryFg: '45 28 5',
    warning: '180 83 9',
    danger: '185 28 28',
    success: '21 128 61',
    info: '13 148 136',
  }

  it('rejects the pre-refresh warm palette', () => {
    const offenders = warmOffenders(preColdClassic)
    expect(offenders.length, 'warm palette slipped through').toBeGreaterThan(3)
    expect(offenders.join('\n')).toContain('primary')
  })

  it('rejects a low-contrast accent rather than passing it silently', () => {
    // White on #0D9488 measured 3.74:1 — the exact case the AA list must catch.
    const fg = parseChannels('255 255 255', 'white')
    const bg = parseChannels('13 148 136', 'teal-600')
    expect(contrast(fg, bg)).toBeLessThan(4.5)
  })
})

describe('brand palettes stay cold', () => {
  it('covers every preset in both modes with all twelve channels', () => {
    expect(brands.length).toBeGreaterThan(0)
    for (const brand of brands) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = BRAND_PALETTES[brand as keyof typeof BRAND_PALETTES][mode]
        expect(palette, `${brand}/${mode}: palette missing`).toBeTruthy()
        for (const key of KEYS) {
          parseChannels(palette[key], `${brand}/${mode}.${key}`)
        }
      }
    }
  })

  for (const brand of brands) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${brand}/${mode}: structural colors are cool or neutral`, () => {
        const palette = BRAND_PALETTES[brand as keyof typeof BRAND_PALETTES][mode]
        const offenders = warmOffenders(palette)
        expect(offenders, `warm hues left in ${brand}/${mode}:\n${offenders.join('\n')}`).toEqual([])
      })
    }
  }
})

describe('brand palettes stay readable', () => {
  // Text pairs must clear AA for normal text.
  const TEXT_PAIRS: [keyof BrandPalette, keyof BrandPalette, number][] = [
    ['foreground', 'surface', 4.5],
    ['foreground', 'surfaceElevated', 4.5],
    ['foreground', 'canvas', 4.5],
    ['muted', 'surface', 4.5],
    ['muted', 'surfaceElevated', 4.5],
    ['primaryFg', 'primary', 4.5],
  ]
  // Non-text UI (accent on a panel) only needs 3:1.
  const UI_PAIRS: [keyof BrandPalette, keyof BrandPalette, number][] = [
    ['primary', 'surface', 3],
    ['primary', 'surfaceElevated', 3],
    ['danger', 'surface', 3],
    ['success', 'surface', 3],
    ['warning', 'surface', 3],
    ['info', 'surface', 3],
  ]

  for (const brand of brands) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${brand}/${mode}: contrast meets AA`, () => {
        const palette = BRAND_PALETTES[brand as keyof typeof BRAND_PALETTES][mode]
        const failures: string[] = []
        for (const [fgKey, bgKey, min] of [...TEXT_PAIRS, ...UI_PAIRS]) {
          const fg = parseChannels(palette[fgKey], `${brand}/${mode}.${fgKey}`)
          const bg = parseChannels(palette[bgKey], `${brand}/${mode}.${bgKey}`)
          const ratio = contrast(fg, bg)
          if (ratio < min) {
            failures.push(`${fgKey} on ${bgKey}: ${ratio.toFixed(2)}:1 (need ${min}:1) ${toHex(fg)} / ${toHex(bg)}`)
          }
        }
        expect(failures, `${brand}/${mode} contrast failures:\n${failures.join('\n')}`).toEqual([])
      })
    }
  }

  for (const brand of brands) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${brand}/${mode}: surfaces are distinct from the canvas`, () => {
        const palette = BRAND_PALETTES[brand as keyof typeof BRAND_PALETTES][mode]
        const canvas = parseChannels(palette.canvas, `${brand}/${mode}.canvas`)
        const surface = parseChannels(palette.surface, `${brand}/${mode}.surface`)
        const elevated = parseChannels(palette.surfaceElevated, `${brand}/${mode}.surfaceElevated`)
        // Panels must separate from the page, but not by much — flat UI.
        expect(contrast(surface, canvas), `${brand}/${mode}: surface indistinguishable from canvas`)
          .toBeGreaterThan(1.06)
        expect(contrast(elevated, surface), `${brand}/${mode}: elevated indistinguishable from surface`)
          .toBeGreaterThan(1.06)
        expect(contrast(elevated, canvas), `${brand}/${mode}: too much layering`)
          .toBeLessThan(1.9)
      })
    }
  }
})
