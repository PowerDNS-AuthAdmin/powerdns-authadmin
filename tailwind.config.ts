/**
 * tailwind.config.ts — Tailwind v3 configuration.
 *
 * Design tokens (colors, font stack, radii) live in `app/globals.css` as CSS
 * variables on `:root` and `.dark`. Components reference them via Tailwind's
 * arbitrary-value syntax — `text-[color:var(--color-fg)]`,
 * `bg-[color:var(--color-bg-subtle)]` — which works without registering the
 * tokens in this config.
 *
 * That choice puts the design system next to the CSS that consumes it and
 * lets a deployment swap themes by replacing globals.css alone.
 *
 * Dark mode is class-based, toggled by adding/removing the `.dark` class on
 * `<html>`. A theme toggle component lands later
 */

import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      /**
       * App type scale — Tailwind's default sizes (and their line-heights)
       * scaled by 1.2×. This replaces the former `html { font-size: 120% }`
       * hack, which bumped *every* rem (padding, gap, radius) and made the UI
       * feel zoomed. Scaling only the font-size utilities keeps text at the
       * same comfortable size while spacing/radius return to true rem.
       * Pairs are [font-size, line-height].
       */
      fontSize: {
        xs: ["0.9rem", "1.2rem"],
        sm: ["1.05rem", "1.5rem"],
        base: ["1.2rem", "1.8rem"],
        lg: ["1.35rem", "2.1rem"],
        xl: ["1.5rem", "2.1rem"],
        "2xl": ["1.8rem", "2.4rem"],
        "3xl": ["2.25rem", "2.7rem"],
        "4xl": ["2.7rem", "3rem"],
        "5xl": ["3.6rem", "1"],
        "6xl": ["4.5rem", "1"],
        "7xl": ["5.4rem", "1"],
        "8xl": ["7.2rem", "1"],
        "9xl": ["9.6rem", "1"],
      },
    },
  },
  plugins: [],
};

export default config;
