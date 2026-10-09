/**
 * app/api/mcp/route.ts
 *
 * Model Context Protocol endpoint (Streamable HTTP transport, stateless).
 * Lets Claude Code, Codex and any other MCP-capable client manage zones
 * and records in natural language, authenticated with a personal access
 * token. Every tool call runs as the token's owner under the normal RBAC,
 * validation and audit path - see `_server.ts` and `_dispatch.ts`.
 *
 * Stateless by design: each POST builds a fresh server + transport, answers
 * with plain JSON (no SSE stream to keep alive), and tears down. That keeps
 * the endpoint proxy-friendly and horizontally scalable; MCP clients that
 * want a session simply get none and retry statelessly, which the spec
 * allows. GET (standalone SSE stream) and DELETE (end session) therefore
 * answer 405 through the transport.
 *
 * Auth: bearer personal access tokens only. Browser sessions are refused
 * even when a cookie is present, so a page in the operator's browser can
 * never be turned into an MCP client by a third-party site.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { requireUser } from "@/lib/auth/require-user";
import { errorResponse } from "@/lib/http/error-response";
import { buildMcpServer } from "./_server";

function unauthorized(message: string): Response {
  return Response.json(
    { error: message },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="PowerDNS-AuthAdmin MCP", error="invalid_token"',
        "Cache-Control": "no-store",
      },
    },
  );
}

async function handle(request: Request): Promise<Response> {
  if (!request.headers.get("authorization") && !request.headers.get("x-api-key")) {
    return unauthorized(
      "Send a personal access token as `Authorization: Bearer pda_pat_…` (create one under Profile → API tokens).",
    );
  }

  let auth;
  try {
    auth = await requireUser();
  } catch (err) {
    return errorResponse(err, "mcp.auth.error");
  }
  if (auth.source !== "token") {
    return unauthorized(
      "The MCP endpoint accepts personal access tokens only, not browser sessions.",
    );
  }

  const server = buildMcpServer({ request, auth });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void transport.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
