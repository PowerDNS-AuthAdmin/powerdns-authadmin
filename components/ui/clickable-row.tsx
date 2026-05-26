"use client";

/**
 * components/ui/clickable-row.tsx
 *
 * Tiny client wrappers that make a server-rendered table row (or a card div)
 * navigate on click — used by bespoke tables that don't go through DataTable
 * but still want the same "tap anywhere on the row" UX as the DataTable lists.
 *
 * Inner links/buttons/form controls keep working: the click handler bails out
 * if the click target is (or is inside) an interactive element.
 */

import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";

const INNER_INTERACTIVE = "a,button,input,select,textarea,label,[role=button]";

function activate(href: string, router: ReturnType<typeof useRouter>) {
  return (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest(INNER_INTERACTIVE)) return;
    router.push(href);
  };
}

export function ClickableTr({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <tr onClick={activate(href, router)} className={`cursor-pointer ${className ?? ""}`}>
      {children}
    </tr>
  );
}

export function ClickableDiv({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <div onClick={activate(href, router)} className={`cursor-pointer ${className ?? ""}`}>
      {children}
    </div>
  );
}
