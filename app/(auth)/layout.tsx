/**
 * app/(auth)/layout.tsx
 *
 * Layout for the unauthenticated routes: /login, /reset-password, etc.
 * Centered form on the page background - no card chrome, just the brand
 * mark above and the content below. Theme toggle is top-right so users
 * can flip light/dark before signing in.
 */

import { ThemeToggle } from "@/components/ui/theme-toggle";
import { BrandMark } from "@/components/ui/brandmark";
import { DialogProvider } from "@/components/ui/dialog";
import { getAppSettings } from "@/lib/settings/app-settings";

export default async function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { siteName, brandLogoUrl, supportContact } = await getAppSettings();

  return (
    <DialogProvider>
      <main className="relative flex min-h-dvh flex-col items-center justify-center bg-[color:var(--color-bg)] px-4 py-8">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        {/* Wordmark wrapper caps width responsively - 350 px on phones (where
            the 500 px desktop size overflowed and clipped the trailing "Admin"),
            500 px from sm+. The brandmark itself fills the wrapper. */}
        <div className="mb-8 flex w-full justify-center px-4">
          <div className="w-full max-w-[350px] sm:max-w-[500px]">
            <BrandMark siteName={siteName} brandLogoUrl={brandLogoUrl} width="100%" />
          </div>
        </div>
        <div className="w-full max-w-lg">{children}</div>
        {supportContact ? (
          <footer className="mt-8 text-xs text-[color:var(--color-fg-muted)]">
            Need help? {renderSupportContact(supportContact)}
          </footer>
        ) : null}
      </main>
    </DialogProvider>
  );
}

/**
 * The setting accepts arbitrary text; render it as a link when it parses as
 * a URL or an email, otherwise as plain text. Defends against accidental
 * markup injection - values are interpolated, never `dangerouslySetInnerHTML`.
 */
function renderSupportContact(value: string): React.ReactNode {
  const trimmed = value.trim();
  if (/^https?:\/\//.test(trimmed)) {
    return (
      <a href={trimmed} className="underline">
        {trimmed}
      </a>
    );
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return (
      <a href={`mailto:${trimmed}`} className="underline">
        {trimmed}
      </a>
    );
  }
  return trimmed;
}
