/**
 * components/ui/brandmark.tsx
 *
 * Branding banner: renders the default <Wordmark/> unless the operator has
 * set a `brand_logo_url` in /admin/settings, in which case the custom logo
 * is shown instead. The custom URL is treated as user-controlled; we use a
 * plain <img> (not next/image) because we don't want to invoke Next's image
 * optimizer for a third-party URL — and the URL has already been validated
 * by Zod as an absolute http(s) URL.
 *
 * `siteName` is used as the alt text so screen readers still get the brand
 * identity when a custom logo is in play.
 */

import { Wordmark } from "./wordmark";

interface BrandMarkProps {
  siteName: string;
  brandLogoUrl: string | null;
  /** Maximum pixel width for the rendered mark. */
  width: number;
  /**
   * Maximum pixel height for the rendered mark. Provided when the parent has
   * a height constraint (e.g. the 56px-tall sidebar header). Without it, a
   * square custom logo passed `width=224` would render 224×224 and blow out
   * of the slot.
   */
  maxHeight?: number;
  /** Optional className for the wrapper. */
  className?: string;
  /** Above-the-fold? Forwarded to Wordmark for the LCP boost. */
  priority?: boolean;
}

export function BrandMark({
  siteName,
  brandLogoUrl,
  width,
  maxHeight,
  className,
  priority,
}: BrandMarkProps) {
  if (brandLogoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={brandLogoUrl}
        alt={siteName}
        // The brand logo renders on the *unauthenticated* login page. When an
        // operator points it at an externally-hosted URL, suppress the Referer
        // so we don't leak the app's origin/path to that third-party host on
        // every anonymous visit. (The IP leak inherent to any external fetch
        // is an accepted tradeoff of supporting external hosting.)
        referrerPolicy="no-referrer"
        style={{
          maxWidth: width,
          maxHeight: maxHeight ?? "100%",
          width: "auto",
          height: "auto",
          objectFit: "contain",
          display: "block",
        }}
        className={className}
      />
    );
  }
  return (
    <Wordmark
      width={width}
      height={maxHeight ?? "auto"}
      priority={priority}
      className={className}
    />
  );
}
