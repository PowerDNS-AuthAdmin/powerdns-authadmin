/**
 * components/domain/token-reveal-format.ts
 *
 * The pure half of the "new token" panel: the client snippets built from the
 * app's public URL and the freshly issued token, and a tiny highlighter for
 * them. Kept out of the component so both are unit-tested, and hand-rolled
 * because three short snippets in two languages don't justify a syntax
 * highlighting dependency (CONTRIBUTING.md § Dependencies).
 */

/** Name the snippets register the MCP server under (matches docs/14-MCP.md). */
export const MCP_SERVER_NAME = "powerdns";

/** Environment variable the `.mcp.json` snippet reads the token from (docs/14-MCP.md). */
export const MCP_TOKEN_ENV_VAR = "PDNS_AUTHADMIN_TOKEN";

export type SnippetLanguage = "sh" | "json";

export interface TokenSnippet {
  /** Shown above the block. */
  label: string;
  language: SnippetLanguage;
  /** Copied verbatim; may contain the token. */
  code: string;
  /** One line under the block, when the snippet needs a word of context. */
  note?: string;
}

/**
 * Build the "other ways to connect" snippets for a newly issued token.
 *
 * The Claude Code command is pinned to `--scope user`: `--scope project`
 * writes the server, header and all, into the repository's `.mcp.json`, which
 * is how a token ends up committed. The `.mcp.json` snippet is the shareable
 * shape, so it reads the token from the environment instead of embedding it.
 *
 * @param appUrl the deployment's public URL (`APP_URL`, no trailing slash)
 * @param token  the plain token, shown once
 */
export function buildTokenSnippets(appUrl: string, token: string): TokenSnippet[] {
  const mcpUrl = `${appUrl}/api/mcp`;
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV_VAR}}` },
        },
      },
    },
    null,
    2,
  );
  return [
    {
      label: "Claude Code",
      language: "sh",
      code: [
        "# your user only; never --scope project (puts the token in the repo)",
        `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} ${mcpUrl} \\`,
        `  --header "Authorization: Bearer ${token}"`,
      ].join("\n"),
    },
    {
      label: ".mcp.json",
      language: "json",
      code: mcpJson,
      note: `Reads the token from ${MCP_TOKEN_ENV_VAR}; set it in the shell that starts the client.`,
    },
    {
      label: "curl",
      language: "sh",
      code: [
        `curl -sS ${mcpUrl} \\`,
        `  -H "Authorization: Bearer ${token}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Accept: application/json, text/event-stream" \\`,
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join("\n"),
    },
  ];
}

export type HighlightKind =
  | "comment"
  | "string"
  | "variable"
  | "url"
  | "flag"
  | "command"
  | "key"
  | "number"
  | "literal"
  | "secret";

/** A run of text and what it is; `null` is plain text. */
export type HighlightToken = readonly [HighlightKind | null, string];

// Each language's rules join into one alternation, first match wins, so order
// matters (a JSON key is a string followed by a colon; a URL inside quotes is
// part of the string). No capturing groups inside a pattern: the group index
// is how a match finds its kind.
const RULES: Record<SnippetLanguage, ReadonlyArray<readonly [HighlightKind, string]>> = {
  sh: [
    ["comment", String.raw`(?<=^|\s)#[^\n]*`],
    ["string", String.raw`'[^'\n]*'|"(?:[^"\\\n]|\\.)*"`],
    ["variable", String.raw`\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*`],
    ["url", String.raw`https?://[^\s'"]+`],
    ["flag", String.raw`(?<=^|\s)--?[A-Za-z][\w-]*`],
    ["command", String.raw`^[A-Za-z][\w.-]*`],
  ],
  json: [
    ["key", String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`],
    ["string", String.raw`"(?:[^"\\\n]|\\.)*"`],
    ["number", String.raw`-?\b\d+(?:\.\d+)?\b`],
    ["literal", String.raw`\b(?:true|false|null)\b`],
  ],
};

const PATTERNS: Record<SnippetLanguage, RegExp> = {
  sh: compile(RULES.sh),
  json: compile(RULES.json),
};

function compile(rules: ReadonlyArray<readonly [HighlightKind, string]>): RegExp {
  return new RegExp(rules.map(([, pattern]) => `(${pattern})`).join("|"), "gm");
}

/**
 * Split a snippet into highlighted runs. Every occurrence of `secret` becomes
 * its own `"secret"` run (whatever it sat inside) so the panel can mark where
 * the token is. Concatenating the runs' text gives back `code` exactly.
 *
 * @example
 *   highlightCode('curl -H "x"', "sh")
 *   // [["command","curl"],[null," "],["flag","-H"],[null," "],["string",'"x"']]
 */
export function highlightCode(
  code: string,
  language: SnippetLanguage,
  secret?: string,
): HighlightToken[] {
  const rules = RULES[language];
  const pattern = PATTERNS[language];
  const runs: HighlightToken[] = [];
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const at = match.index;
    if (match[0] === "") continue;
    if (at > last) runs.push([null, code.slice(last, at)]);
    const group = match.findIndex((value, index) => index > 0 && value !== undefined);
    runs.push([rules[group - 1]?.[0] ?? null, match[0]]);
    last = at + match[0].length;
  }
  if (last < code.length) runs.push([null, code.slice(last)]);
  if (!secret) return runs;

  const marked: HighlightToken[] = [];
  for (const [kind, text] of runs) {
    text.split(secret).forEach((part, index) => {
      if (index > 0) marked.push(["secret", secret]);
      if (part) marked.push([kind, part]);
    });
  }
  return marked;
}
