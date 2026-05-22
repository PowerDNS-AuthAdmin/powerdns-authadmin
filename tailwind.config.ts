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
    extend: {},
  },
  plugins: [],
};

export default config;
