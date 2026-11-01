import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRAND_PALETTES } from '@/lib/brand-palettes.ts'
import {
  applySelfOrderTheme,
  normalizeSelfOrderBrand,
  resolveSelfOrderTheme,
} from './theme.ts'

describe('self-order theme', () => {
  it('falls back to classic for unknown brands', () => {
    expect(normalizeSelfOrderBrand('ocean')).toBe('ocean')
    expect(normalizeSelfOrderBrand('custom')).toBe('custom')
    expect(normalizeSelfOrderBrand('bogus')).toBe('classic')
    expect(normalizeSelfOrderBrand(undefined)).toBe('classic')
  })

  it('resolves light / dark / system', () => {
    expect(resolveSelfOrderTheme('light', true)).toBe('light')
    expect(resolveSelfOrderTheme('dark', false)).toBe('dark')
    expect(resolveSelfOrderTheme('system', true)).toBe('dark')
    expect(resolveSelfOrderTheme('system', false)).toBe('light')
    expect(resolveSelfOrderTheme(undefined, true)).toBe('dark')
  })

  it('writes the brand palette onto the document', () => {
    const setProperty = vi.fn()
    const original = globalThis.document
    // @ts-expect-error minimal DOM stub for the test
    globalThis.document = { documentElement: { style: { setProperty, colorScheme: '' }, dataset: {} } }

    applySelfOrderTheme('ocean', 'dark')

    const written = new Map<string, string>()
    for (const [name, value] of setProperty.mock.calls) written.set(name, value)

    // Bound to the live preset instead of copied literals: this test is about
    // the mapping (which token lands on which --so-* var), and literals went
    // stale the moment the app went cold.
    const oceanDark = BRAND_PALETTES.ocean.dark
    expect(written.get('--so-paper')).toBe(`rgb(${oceanDark.canvas})`)
    expect(written.get('--so-ink')).toBe(`rgb(${oceanDark.primary})`)
    expect(written.get('--so-on-ink')).toBe(`rgb(${oceanDark.primaryFg})`)
    expect(written.get('--so-card')).toBe(`rgb(${oceanDark.surfaceElevated})`)
    expect(written.get('--so-line')).toBe(`rgb(${oceanDark.border})`)
    expect(written.get('--so-fg')).toBe(`rgb(${oceanDark.foreground})`)
    expect(written.get('--so-muted')).toBe(`rgb(${oceanDark.muted})`)
    expect(written.has('--so-gold-ink')).toBe(true)

    // The full set of vars the QR page reads. A missing one leaves that part of
    // the customer page on the CSS default — half-brand, half-beige.
    for (const name of [
      '--so-paper', '--so-card', '--so-line', '--so-muted', '--so-fg',
      '--so-ink', '--so-on-ink', '--so-gold', '--so-gold-soft', '--so-gold-ink',
      '--so-ink-rgb', '--so-on-ink-rgb', '--so-gold-rgb',
    ]) {
      expect(written.has(name), `${name} was never written`).toBe(true)
    }

    globalThis.document = original
  })

  it('derives the palette from a custom primary', () => {
    const setProperty = vi.fn()
    const original = globalThis.document
    // @ts-expect-error minimal DOM stub for the test
    globalThis.document = { documentElement: { style: { setProperty, colorScheme: '' }, dataset: {} } }

    applySelfOrderTheme('custom', 'light', '#ff0000')

    const written = new Map<string, string>()
    for (const [name, value] of setProperty.mock.calls) written.set(name, value)
    const primary = written.get('--so-ink') ?? ''
    const [r, g, b] = (primary.match(/\d+/g) ?? []).map(Number)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)

    globalThis.document = original
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
