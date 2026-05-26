import Link from "next/link";
import { Plus } from "lucide-react";

/**
 * components/ui/create-button.tsx
 *
 * Primary "create / add" call-to-action. Green (deliberately distinct from the
 * indigo accent the app uses for active tabs/links) with a leading plus icon.
 * Full-width on mobile, auto-width on `sm+` — pairs with the stacked page
 * headers so the CTA reads as a clear full-width button on a phone.
 *
 * `createCtaClass` is exported for the handful of CTAs that are <button>s
 * (e.g. "Add record", which opens a dialog) rather than links.
 */
export const createCtaClass =
  "inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-[color:var(--color-success)] px-4 py-2 text-sm font-medium text-white hover:opacity-95 sm:w-auto";

export function CreateButton({
  href,
  label,
  className = "",
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <Link href={href} className={`${createCtaClass} ${className}`}>
      <Plus className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  );
}
