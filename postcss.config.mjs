/**
 * postcss.config.mjs
 *
 * PostCSS pipeline for Tailwind v4. The single `@tailwindcss/postcss` plugin
 * replaces the v3 `tailwindcss` + `autoprefixer` pair — v4 handles vendor
 * prefixing internally (via Lightning CSS), so autoprefixer is no longer a
 * dependency.
 */

export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
