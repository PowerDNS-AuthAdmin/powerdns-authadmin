"use client";

/**
 * app/(app)/zones/[zoneId]/_components/bind-diff-view.tsx
 *
 * Side-by-side / unified diff of the zone's BIND zonefile, before vs after a
 * pending edit. Powered by `react-diff-viewer-continued` — the maintained
 * successor to `react-diff-viewer` — so we get a battle-tested diff renderer
 * (line numbers, expand-collapsed, sub-line word diff, accessibility) for
 * free, themed against our design tokens.
 *
 * Theme: the component re-reads `.dark` on `<html>` via MutationObserver and
 * swaps `useDarkTheme` accordingly. Per-token color overrides are layered on
 * top so backgrounds + line numbers blend with the app frame instead of the
 * library's default greyscale.
 *
 * Syntax highlighting: `renderContent` runs each line through the BIND
 * tokenizer in `lib/dns/bind-format.ts` and renders color-classed spans —
 * directives, RR type, ttl/class, comments all get their own color so the
 * diff doubles as a readable zonefile view.
 */

import { useEffect, useMemo, useState } from "react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import {
  rrsetsToBindZonefile,
  tokenizeBindLine,
  type BindRRset,
  type BindToken,
} from "@/lib/dns/bind-format";

interface BindDiffViewProps {
  zoneName: string;
  before: BindRRset[];
  after: BindRRset[];
  /** Default true (side-by-side). Pass false for unified. */
  splitView?: boolean;
  /**
   * Bare-diff mode for the change-history feed. When true:
   *   - The "Zone:" / "Layout:" wrapper header is hidden.
   *   - The "Before" / "After" column titles are hidden.
   *   - Line-number gutters are hidden (CSS) and the gutter columns shrink.
   *   - Context around hunks shrinks to 0 lines (only changed lines render).
   *   - The library's "X collapsed lines" fold marker is hidden via CSS so
   *     the operator doesn't see a "ghost" row between hunks.
   *
   * Default false — the Review dialog keeps the richer rendering so
   * operators can scan a full before/after of the zone before applying.
   */
  compact?: boolean;
}

export function BindDiffView({
  zoneName,
  before,
  after,
  splitView = true,
  compact = false,
}: BindDiffViewProps) {
  const beforeText = useMemo(() => rrsetsToBindZonefile(before), [before]);
  const afterText = useMemo(() => rrsetsToBindZonefile(after), [after]);
  const isDark = useIsDark();

  return (
    <div className="space-y-3">
      {compact ? null : (
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="text-[color:var(--color-fg-muted)]">
            Zone: <span className="font-mono">{zoneName}</span>
          </span>
          <span className="text-[color:var(--color-fg-muted)]">
            Layout: {splitView ? "side-by-side" : "unified"}
          </span>
        </div>
      )}

      <div
        className={
          compact
            ? "overflow-auto rounded-md border border-[color:var(--color-border)]"
            : "max-h-[60vh] overflow-auto rounded-md border border-[color:var(--color-border)]"
        }
      >
        <ReactDiffViewer
          oldValue={beforeText}
          newValue={afterText}
          splitView={splitView}
          useDarkTheme={isDark}
          compareMethod={DiffMethod.LINES}
          showDiffOnly
          extraLinesSurroundingDiff={compact ? 0 : 3}
          hideLineNumbers={compact}
          leftTitle={compact ? undefined : "Before"}
          rightTitle={compact ? undefined : splitView ? "After" : undefined}
          renderContent={renderBindContent}
          styles={diffStyles(isDark, compact)}
        />
      </div>
    </div>
  );
}

/**
 * Watch the `.dark` class on `<html>` so the diff theme follows the app's
 * theme toggle without a remount.
 */
function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const read = () => document.documentElement.classList.contains("dark");
    setIsDark(read());
    const observer = new MutationObserver(() => setIsDark(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

// =============================================================================
// Per-line BIND syntax highlighting
// =============================================================================

function renderBindContent(line: string): React.ReactElement {
  const tokens = tokenizeBindLine(line);
  return (
    <>
      {tokens.map((token, idx) => (
        <span key={idx} className={classForToken(token)}>
          {token.text}
        </span>
      ))}
    </>
  );
}

function classForToken(token: BindToken): string {
  switch (token.kind) {
    case "directive":
      return "text-[color:var(--color-accent)] font-semibold";
    case "comment":
      return "text-[color:var(--color-fg-subtle)] italic";
    case "disabled":
      return "text-[color:var(--color-warn)] italic";
    case "ttl":
      return "text-[color:var(--color-fg-muted)]";
    case "class":
      return "text-[color:var(--color-fg-subtle)] uppercase";
    case "type":
      return "text-[color:var(--color-accent)] font-medium";
    case "name":
    case "rdata":
    case "whitespace":
    case "empty":
    default:
      return "";
  }
}

// =============================================================================
// Style overrides — blend the library's frame with our design tokens
// =============================================================================

/**
 * Build the `styles` object react-diff-viewer-continued accepts. We override
 * the chrome (gutter, line numbers, headers, container) plus add/remove
 * tints so the diff aligns with our --color-success / --color-error
 * semantic tokens. We use raw hex/rgba values here because Emotion (the
 * library's styling engine) can't resolve CSS variables defined on `:root`
 * — those only paint on the DOM at render time, not at serialization.
 */
function diffStyles(isDark: boolean, compact = false) {
  const bg = isDark ? "#0a0a0a" : "#ffffff";
  const bgSubtle = isDark ? "#1a1a1a" : "#f5f5f5";
  const bgMuted = isDark ? "#262626" : "#e5e5e5";
  const border = isDark ? "#3f3f46" : "#e5e7eb";
  const text = isDark ? "#fafafa" : "#171717";
  const muted = isDark ? "#a1a1aa" : "#52525b";
  const subtle = isDark ? "#71717a" : "#a1a1aa";

  // Diff add/remove tints. Low row opacity so syntax tokens stay readable;
  // higher word-level opacity to spotlight the actual changed chars.
  const addBg = isDark ? "rgba(34,197,94,0.12)" : "rgba(34,197,94,0.18)";
  const addGutter = isDark ? "rgba(34,197,94,0.20)" : "rgba(34,197,94,0.30)";
  const addWord = isDark ? "rgba(34,197,94,0.45)" : "rgba(34,197,94,0.55)";
  const removeBg = isDark ? "rgba(239,68,68,0.12)" : "rgba(239,68,68,0.18)";
  const removeGutter = isDark ? "rgba(239,68,68,0.20)" : "rgba(239,68,68,0.30)";
  const removeWord = isDark ? "rgba(239,68,68,0.45)" : "rgba(239,68,68,0.55)";

  const palette = {
    diffViewerBackground: bg,
    diffViewerColor: text,
    addedBackground: addBg,
    addedColor: text,
    removedBackground: removeBg,
    removedColor: text,
    wordAddedBackground: addWord,
    wordRemovedBackground: removeWord,
    addedGutterBackground: addGutter,
    removedGutterBackground: removeGutter,
    gutterBackground: bgSubtle,
    gutterBackgroundDark: bgSubtle,
    highlightBackground: bgMuted,
    highlightGutterBackground: bgMuted,
    codeFoldGutterBackground: bgMuted,
    codeFoldBackground: bgSubtle,
    emptyLineBackground: bg,
    gutterColor: subtle,
    addedGutterColor: text,
    removedGutterColor: text,
    codeFoldContentColor: muted,
    diffViewerTitleBackground: bgSubtle,
    diffViewerTitleColor: muted,
    diffViewerTitleBorderColor: border,
  };

  // In compact mode hide the gutter column entirely (no line numbers, no
  // code-fold "X lines hidden" summary row). extraLinesSurroundingDiff=0
  // keeps fold sections from being created in the first place; these
  // style overrides cover the case where the lib still reserves a row.
  // `marker` (the +/- gutter glyph) is hidden in BOTH modes — the
  // operator identifies sides via column header + row tint, not a glyph.
  const compactOverrides = compact
    ? {
        gutter: { display: "none" as const },
        codeFold: { display: "none" as const },
        codeFoldGutter: { display: "none" as const },
        codeFoldContent: { display: "none" as const },
        titleBlock: { display: "none" as const },
      }
    : {
        gutter: {
          minWidth: 36,
          padding: "0 8px",
          fontSize: 11,
        },
      };

  return {
    variables: { light: palette, dark: palette },
    contentText: {
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.55,
    },
    marker: { display: "none" as const },
    ...compactOverrides,
  };
}
