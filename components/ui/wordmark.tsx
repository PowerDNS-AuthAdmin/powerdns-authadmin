/**
 * components/ui/wordmark.tsx
 *
 * Brand wordmark with automatic light/dark swap.
 *
 * Source assets live in /public/brand/ as two PNGs:
 *   - logo-wordmark-light.png — dark ink on transparent (for light backgrounds)
 *   - logo-wordmark-dark.png  — light ink on transparent (for dark backgrounds)
 *
 * Both versions ship with the app (no external CDN per CONTRIBUTING.md).
 * The Tailwind `dark:` class on <html> picks which one is visible — there's
 * no JS hop, so the right variant appears before hydration completes.
 *
 * Both images render in the DOM (so the swap is paint-time, no JS hop), but
 * we deliberately do NOT pass `priority` to next/image: priority emits a
 * `<link rel="preload">` per Image, and with two images where CSS hides one,
 * the preloaded hidden variant fires a "preload was not used within a few
 * seconds" browser warning every page load. The visible image loads eagerly
 * anyway because it's above the fold; the wordmark is small enough that the
 * extra preload buys no measurable LCP gain.
 */

import Image from "next/image";

const INTRINSIC_WIDTH = 2880;
const INTRINSIC_HEIGHT = 800;

interface WordmarkProps {
  /** Wrapper width — any CSS length (e.g. 500, "500px", "100%", "auto"). */
  width?: string | number;
  /** Wrapper height — same accepted forms. Default "auto" so the intrinsic ratio holds when only width is set. */
  height?: string | number;
  /** Extra wrapper classes. */
  className?: string;
  /** Inline style overrides merged onto the wrapper. */
  style?: React.CSSProperties;
}

/**
 * Renders the PowerDNS-AuthAdmin wordmark, swapping the light- and dark-background
 * variants based on the active theme. Sizing is controlled by the parent
 * span — pass width / height / style as you would on any block element.
 */
export function Wordmark({ width, height = "auto", className = "", style }: WordmarkProps) {
  const alt = "PowerDNS-AuthAdmin";

  return (
    <span
      className={`inline-block ${className}`}
      style={{ width, height, ...style }}
      aria-label={alt}
      role="img"
    >
      <Image
        src="/brand/logo-wordmark-light.png"
        alt=""
        width={INTRINSIC_WIDTH}
        height={INTRINSIC_HEIGHT}
        className="block h-auto w-full object-contain dark:hidden"
      />
      <Image
        src="/brand/logo-wordmark-dark.png"
        alt=""
        width={INTRINSIC_WIDTH}
        height={INTRINSIC_HEIGHT}
        className="hidden h-auto w-full object-contain dark:block"
      />
    </span>
  );
}
