import { describe, expect, it } from "vitest";
import {
  buildTokenSnippets,
  highlightCode,
  MCP_TOKEN_ENV_VAR,
  type HighlightToken,
} from "./token-reveal-format";

const APP_URL = "https://dns.example.com";
const TOKEN = "pda_pat_EXAMPLEonlyEXAMPLEonlyEXAMPLE01";

function joined(runs: HighlightToken[]): string {
  return runs.map(([, text]) => text).join("");
}

describe("buildTokenSnippets", () => {
  const snippets = buildTokenSnippets(APP_URL, TOKEN);

  it("offers Claude Code, .mcp.json and curl, in that order", () => {
    expect(snippets.map((s) => s.label)).toEqual(["Claude Code", ".mcp.json", "curl"]);
  });

  it("adds the server for the user only, never for the project", () => {
    const claude = snippets[0]!.code;
    expect(claude).toContain(
      "claude mcp add --transport http --scope user powerdns https://dns.example.com/api/mcp",
    );
    expect(claude).toContain(`--header "Authorization: Bearer ${TOKEN}"`);
    expect(claude).toMatch(/^# .*never --scope project/);
    expect(
      claude
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join("\n"),
    ).not.toContain("--scope project");
  });

  it("keeps the token out of .mcp.json and reads it from the environment", () => {
    const json = snippets[1]!;
    expect(json.code).not.toContain(TOKEN);
    const parsed = JSON.parse(json.code) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(parsed.mcpServers["powerdns"]).toEqual({
      type: "http",
      url: "https://dns.example.com/api/mcp",
      headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV_VAR}}` },
    });
    expect(json.note).toContain(MCP_TOKEN_ENV_VAR);
  });

  it("lists the MCP tools with curl using the token", () => {
    const curl = snippets[2]!.code;
    expect(curl).toContain("curl -sS https://dns.example.com/api/mcp");
    expect(curl).toContain(`-H "Authorization: Bearer ${TOKEN}"`);
    expect(curl).toContain('"method":"tools/list"');
  });
});

describe("highlightCode", () => {
  it("round-trips every snippet exactly", () => {
    for (const snippet of buildTokenSnippets(APP_URL, TOKEN)) {
      expect(joined(highlightCode(snippet.code, snippet.language, TOKEN))).toBe(snippet.code);
      expect(joined(highlightCode(snippet.code, snippet.language))).toBe(snippet.code);
    }
  });

  it("tags shell commands, flags, strings, urls and comments", () => {
    const runs = highlightCode(
      "# note\ncurl -sS https://x.example/api -H \"Accept: a\" --data '{}' $TOKEN",
      "sh",
    );
    const kinds = runs.filter(([kind]) => kind !== null);
    expect(kinds).toEqual([
      ["comment", "# note"],
      ["command", "curl"],
      ["flag", "-sS"],
      ["url", "https://x.example/api"],
      ["flag", "-H"],
      ["string", '"Accept: a"'],
      ["flag", "--data"],
      ["string", "'{}'"],
      ["variable", "$TOKEN"],
    ]);
  });

  it("does not read a dash inside a word as a flag", () => {
    const runs = highlightCode("claude mcp-remote x", "sh");
    expect(runs.some(([kind]) => kind === "flag")).toBe(false);
  });

  it("tells JSON keys from string values", () => {
    const runs = highlightCode('{ "a": "b", "n": 2, "t": true }', "json");
    expect(runs.filter(([kind]) => kind !== null)).toEqual([
      ["key", '"a"'],
      ["string", '"b"'],
      ["key", '"n"'],
      ["number", "2"],
      ["key", '"t"'],
      ["literal", "true"],
    ]);
  });

  it("marks every occurrence of the secret, even inside a string", () => {
    const code = `a "Bearer ${TOKEN}" ${TOKEN}`;
    const secrets = highlightCode(code, "sh", TOKEN).filter(([kind]) => kind === "secret");
    expect(secrets).toEqual([
      ["secret", TOKEN],
      ["secret", TOKEN],
    ]);
  });
});
