"use client";

/**
 * components/domain/token-reveal.tsx
 *
 * The "your new token" panel shown once after a personal access token is
 * issued. The plain token is the hero with one Copy button, because the token
 * on its own is what most people need; the client set-up snippets (Claude
 * Code, `.mcp.json`, curl) sit folded underneath so nobody copies a whole
 * command - token included - into a config file by accident.
 *
 * A deployment can add a hint badge between the two (`TOKEN_SETUP_HINT_*`,
 * read on the server and passed in) when it hands tokens to a setup tool of
 * its own. Without it the panel shows no hint.
 */

import { useEffect, useRef, useState } from "react";
import { Disclosure } from "@/components/ui/disclosure";
import { useDialog } from "@/components/ui/dialog";
import {
  buildTokenSnippets,
  highlightCode,
  type HighlightKind,
  type SnippetLanguage,
} from "./token-reveal-format";

/** The optional deployment hint; mirrors `TokenSetupHint` in lib/env.ts. */
export interface TokenRevealHint {
  command: string;
  text: string | null;
  url: string | null;
}

interface TokenRevealProps {
  /** The plain token, shown once. */
  token: string;
  /** The name the token was issued under. */
  name: string;
  /** The deployment's public URL (`APP_URL`), for the snippets. */
  appUrl: string;
  hint: TokenRevealHint | null;
  onDone: () => void;
}

const MCP_GUIDE_URL =
  "https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/blob/main/docs/14-MCP.md";

const COPIED_FEEDBACK_MS = 2000;

// Upstream's semantic `-fg` tokens are the ones tuned for text contrast in
// both themes, so the snippet colours come from them rather than a palette
// of their own.
const KIND_CLASS: Record<HighlightKind, string> = {
  comment: "text-[color:var(--color-fg-subtle)] italic",
  string: "text-[color:var(--color-success-fg)]",
  variable: "text-[color:var(--color-orange-fg)]",
  url: "text-[color:var(--color-accent)]",
  flag: "text-[color:var(--color-warn-fg)]",
  command: "font-semibold text-[color:var(--color-fg)]",
  key: "text-[color:var(--color-accent)]",
  number: "text-[color:var(--color-orange-fg)]",
  literal: "text-[color:var(--color-error-fg)]",
  secret:
    "rounded-sm bg-[color:var(--color-warn)]/25 px-0.5 text-[color:var(--color-fg)] ring-1 ring-[color:var(--color-warn)]/60",
};

export function TokenReveal({ token, name, appUrl, hint, onDone }: TokenRevealProps) {
  const snippets = buildTokenSnippets(appUrl, token);
  return (
    <section
      aria-labelledby="token-reveal-title"
      className="mb-4 space-y-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4 sm:p-5"
    >
      <header className="space-y-1">
        <h3 id="token-reveal-title" className="text-base font-semibold tracking-tight">
          Your new token
          <span className="ml-2 text-sm font-normal text-[color:var(--color-fg-muted)]">
            {name}
          </span>
        </h3>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          <strong className="font-semibold text-[color:var(--color-fg)]">Shown once.</strong> Copy
          it now: only a hash is stored, so it can&apos;t be shown again.
        </p>
      </header>

      <div className="flex flex-wrap items-stretch gap-2">
        <code
          data-testid="token-value"
          className="flex min-h-11 min-w-0 flex-[1_1_18rem] items-center rounded-md border border-[color:var(--color-fg-subtle)] bg-[color:var(--color-bg-subtle)] px-3 py-2 font-mono text-sm break-all select-all"
        >
          {token}
        </code>
        <CopyButton text={token} label="Copy token" primary />
      </div>

      {hint ? <SetupHint hint={hint} /> : null}

      <Disclosure
        label={hint ? "Other ways to connect (advanced)" : "Connect a client (advanced)"}
        className="border-t border-[color:var(--color-border)] pt-3"
        summaryClassName="text-sm font-medium"
        bodyClassName="mt-3 space-y-4"
      >
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          {hint
            ? `These put the token in a command or a file on your computer. ${hint.command} is the simpler way.`
            : "These put the token in a command or a file on your computer. Keep it out of anything you commit."}
        </p>
        {snippets.map((snippet) => (
          <div key={snippet.label} className="min-w-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-[color:var(--color-fg-muted)]">
              <span>{snippet.label}</span>
              <CopyButton text={snippet.code} label="Copy" ariaLabel={`Copy ${snippet.label}`} />
            </div>
            <CodeBlock code={snippet.code} language={snippet.language} secret={token} />
            {snippet.note ? (
              <p className="text-xs text-[color:var(--color-fg-muted)]">{snippet.note}</p>
            ) : null}
          </div>
        ))}
      </Disclosure>

      <footer className="flex flex-wrap items-center justify-between gap-3">
        <a
          href={MCP_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-[color:var(--color-accent)] underline-offset-2 hover:underline"
        >
          Guide: tokens and MCP clients
        </a>
        <button
          type="button"
          onClick={onDone}
          className="min-h-9 rounded-md border border-[color:var(--color-border)] px-4 text-sm font-medium hover:bg-[color:var(--color-bg-muted)]"
        >
          Done
        </button>
      </footer>
    </section>
  );
}

function SetupHint({ hint }: { hint: TokenRevealHint }) {
  const badgeClass =
    "inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-accent)] px-3 py-0.5 font-mono text-xs font-semibold whitespace-nowrap text-[color:var(--color-accent-fg)] no-underline";
  const badgeContent = (
    <>
      <span aria-hidden className="text-[0.625rem] opacity-80">
        ❯
      </span>
      {hint.command}
    </>
  );
  return (
    <div
      data-testid="token-setup-hint"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-4 py-3 text-sm"
    >
      {hint.url ? (
        <a href={hint.url} target="_blank" rel="noreferrer" className={badgeClass}>
          {badgeContent}
        </a>
      ) : (
        <span className={badgeClass}>{badgeContent}</span>
      )}
      <span className="min-w-0 flex-[1_1_16rem]">
        {hint.text ?? `Paste just this token when ${hint.command} asks for it.`}
      </span>
    </div>
  );
}

function CodeBlock({
  code,
  language,
  secret,
}: {
  code: string;
  language: SnippetLanguage;
  secret: string;
}) {
  return (
    <pre className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre">
      <code>
        {highlightCode(code, language, secret).map(([kind, text], index) =>
          kind ? (
            <span key={index} className={KIND_CLASS[kind]}>
              {text}
            </span>
          ) : (
            text
          ),
        )}
      </code>
    </pre>
  );
}

function CopyButton({
  text,
  label,
  ariaLabel,
  primary,
}: {
  text: string;
  label: string;
  ariaLabel?: string;
  primary?: boolean;
}) {
  const { toast } = useDialog();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access is refused on plain http:// and in some embedded
      // browsers; the value stays selectable, so say so instead of failing quietly.
      toast({ kind: "error", description: "Couldn't copy. Select the text and copy it instead." });
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }

  const className = primary
    ? "min-h-11 rounded-md bg-[color:var(--color-accent)] px-4 text-sm font-semibold whitespace-nowrap text-[color:var(--color-accent-fg)] hover:opacity-95"
    : "min-h-7 rounded border border-[color:var(--color-border)] px-2 text-xs font-medium whitespace-nowrap text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-muted)]";
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? undefined : ariaLabel}
      className={copied ? `${className} ring-2 ring-[color:var(--color-success)]` : className}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}
