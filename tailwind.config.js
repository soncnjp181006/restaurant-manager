/** @type {import('tailwindcss').Config} */
const withAlpha = (cssVar) => `rgb(var(${cssVar}) / <alpha-value>)`;

/**
 * Cold neutral ramps.
 *
 * `neutral` used to be Tailwind's achromatic scale, and ~290 utilities across
 * the app (mostly `dark:bg-neutral-800`, `hover:bg-neutral-100`, …) sit on top
 * of it. Keeping those class names but tinting the ramp blue is what makes the
 * whole app cold without a text sweep — the lightness ladder is unchanged, so
 * every existing contrast ratio still holds.
 */
const ice = {
  50: "#f7fafc",
  100: "#eef3f8",
  200: "#dfe7f0",
  300: "#c3cfdd",
  400: "#8fa2b8",
  500: "#64798f",
  600: "#4c5f74",
  700: "#374658",
  800: "#22303f",
  900: "#0f1620",
  950: "#070b12",
};

const slate = {
  50: "#f8fafc",
  100: "#f1f5f9",
  200: "#e2e8f0",
  300: "#cbd5e1",
  400: "#94a3b8",
  500: "#64748b",
  600: "#475569",
  700: "#334155",
  800: "#1e293b",
  900: "#0f172a",
  950: "#020617",
};

/**
 * Cold aliases for the raw hue names.
 *
 * `theme.colors` above replaces Tailwind's palette, so utilities like
 * `text-red-600` (43 uses), `text-green-600`, `bg-green-50`, `focus:bg-rose-600`
 * were emitting no CSS at all — error text silently rendered as body text.
 * Rather than sweep ~30 files, each raw hue is mapped onto the matching cold
 * semantic ramp: the classes become live again and stay on-palette.
 */
const dangerRamp = {  50: "#fff1f3",
  100: "#FFE4E6",
  200: "#FECCD3",
  300: "#FDA4AF",
  400: "#FB7185",
  500: "#F43F5E",
  600: "#E11D48",
  700: "#BE123C",
  800: "#9F1239",
  900: "#881337",
};
const successRamp = {
  50: "#f0fbfa",
  100: "#CCFBF1",
  200: "#99F6E4",
  300: "#5EEAD4",
  400: "#2DD4BF",
  500: "#14B8A6",
  600: "#0D9488",
  700: "#0F766E",
  800: "#115E59",
  900: "#134E4A",
};
const warningRamp = {
  50: "#fdf6e9",
  100: "#FEF3C7",
  200: "#FDE68A",
  300: "#FCD34D",
  400: "#FBBF24",
  500: "#F59E0B",
  600: "#D97706",
  700: "#B45309",
  800: "#92400E",
  900: "#78350F",
};
const infoRamp = {
  50: "#f2f9fd",
  100: "#E0F2FE",
  200: "#BAE6FD",
  300: "#7DD3FC",
  400: "#38BDF8",
  500: "#0EA5E9",
  600: "#0284C7",
  700: "#0369A1",
  800: "#075985",
  900: "#0C4A6E",
};
const primaryRamp = {
  50: "#eff9fc",
  100: "#D0F4FB",
  200: "#A3EBF6",
  300: "#67DBEE",
  400: "#22C9E6",
  500: "#0E9FC0",
  600: "#0E7490",
  700: "#155E75",
  800: "#164E63",
  900: "#083344",
};
const violetRamp = {
  50: "#f5f5fd",
  100: "#E0E7FF",
  200: "#C7D2FE",
  300: "#A5B4FC",
  400: "#818CF8",
  500: "#6366F1",
  600: "#4F46E5",
  700: "#4338CA",
  800: "#3730A3",
  900: "#312E81",
};

module.exports = {
  content: [
    // ...
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /**
       * Tailwind's default shadows are pure black, which reads muddy on a
       * blue-tinted canvas. Every `shadow*` utility in the app now lifts a
       * cold navy shadow instead — no per-component edits.
       */
      boxShadow: {
        DEFAULT: "0 1px 3px 0 rgb(15 34 56 / 0.12), 0 1px 2px -1px rgb(15 34 56 / 0.10)",
        md: "0 4px 6px -1px rgb(15 34 56 / 0.14), 0 2px 4px -2px rgb(15 34 56 / 0.10)",
        lg: "0 10px 15px -3px rgb(15 34 56 / 0.18), 0 4px 6px -4px rgb(15 34 56 / 0.12)",
        xl: "0 20px 25px -5px rgb(15 34 56 / 0.24), 0 8px 10px -6px rgb(15 34 56 / 0.16)",
        "2xl": "0 25px 50px -12px rgb(15 34 56 / 0.40)",
      },
    },
    colors: {
      transparent: "transparent",
      current: "currentColor",
      black: "#0a0f16",
      white: "#f8fafc",
      gray: ice,
      neutral: ice,
      // Semantic theme surfaces (see :root / .dark in app.scss)
      canvas: withAlpha("--canvas"),
      surface: withAlpha("--surface"),
      "surface-elevated": withAlpha("--surface-elevated"),
      foreground: withAlpha("--foreground"),
      muted: withAlpha("--muted"),
      border: withAlpha("--border"),
      // Status colors stay semantic (amber/red/green are load-bearing in a POS),
      // but each ramp is re-hued to the cool side so it sits on blue surfaces.
      success: {
        DEFAULT: withAlpha("--success"),
        100: "#CCFBF1",
        200: "#99F6E4",
        300: "#5EEAD4",
        400: "#2DD4BF",
        500: "#14B8A6",
        600: "#0D9488",
        700: "#0F766E",
        800: "#115E59",
        900: "#134E4A",
      },
      primary: {
        DEFAULT: withAlpha("--primary"),
        fg: withAlpha("--primary-fg"),
        100: "#D0F4FB",
        200: "#A3EBF6",
        300: "#67DBEE",
        400: "#22C9E6",
        500: "#0E9FC0",
        600: "#0E7490",
        700: "#155E75",
        800: "#164E63",
        900: "#083344",
      },
      warning: {
        DEFAULT: withAlpha("--warning"),
        100: "#FEF3C7",
        200: "#FDE68A",
        300: "#FCD34D",
        400: "#FBBF24",
        500: "#F59E0B",
        600: "#D97706",
        700: "#B45309",
        800: "#92400E",
        900: "#78350F",
      },
      danger: {
        DEFAULT: withAlpha("--danger"),
        100: "#FFE4E6",
        200: "#FECCD3",
        300: "#FDA4AF",
        400: "#FB7185",
        500: "#F43F5E",
        600: "#E11D48",
        700: "#BE123C",
        800: "#9F1239",
        900: "#881337",
      },
      info: {
        DEFAULT: withAlpha("--info"),
        100: "#E0F2FE",
        200: "#BAE6FD",
        300: "#7DD3FC",
        400: "#38BDF8",
        500: "#0EA5E9",
        600: "#0284C7",
        700: "#0369A1",
        800: "#075985",
        900: "#0C4A6E",
      },
      slate,
      // Cold aliases so the raw-hue utilities already in the markup resolve.
      red: dangerRamp,
      rose: dangerRamp,
      green: successRamp,
      emerald: successRamp,
      teal: successRamp,
      orange: warningRamp,
      amber: warningRamp,
      yellow: warningRamp,
      blue: infoRamp,
      sky: infoRamp,
      cyan: primaryRamp,
      indigo: violetRamp,
      violet: violetRamp,
      purple: violetRamp,
      fuchsia: violetRamp,
      pink: dangerRamp,
    },
  },
  darkMode: "class",
  plugins: [
    require('tailwindcss-react-aria-components'),
    require("tailwindcss-animate"),
  ],
};
