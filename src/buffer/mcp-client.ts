/**
 * Buffer MCP client — the PRIMARY access rail (Mike's direction,
 * 2026-10-24).
 *
 * Buffer runs an official remote MCP server at https://mcp.buffer.com/mcp
 * (docs: developers.buffer.com/guides/integrations/mcp.html). Listed
 * clients authenticate with OAuth; unlisted tools authenticate with an
 * API key sent as `Authorization: Bearer <key>` — that key comes from the
 * BUFFER_API_KEY env var here (name only in source; the value is a Worker
 * secret, never committed).
 *
 * Transport: MCP over Streamable HTTP — JSON-RPC 2.0 POSTs, responses may
 * be plain JSON or an SSE stream. The client performs the initialize
 * handshake lazily on first use, keeps the Mcp-Session-Id if the server
 * issues one, and exposes:
 *   - the named tools (get_account, list_channels, post CRUD, ideas,
 *     templates, metrics)
 *   - the advanced trio — introspect_schema, execute_query,
 *     execute_mutation — which reach the FULL GraphQL API, including all
 *     ContentItem operations (that's how the MCP rail serves the
 *     BufferRail interface in rail.ts, using the same GraphQL documents
 *     as the fallback rail, from queries.ts)
 *
 * Named-tool argument shapes marked "pass-through" are thin wrappers
 * until confirmed against the live server during build week 1.
 */

export const BUFFER_MCP_URL = "https://mcp.buffer.com/mcp";

export interface BufferMcpEnv {
  BUFFER_API_KEY?: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class BufferMcpClient {
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;

  constructor(private readonly env: BufferMcpEnv) {}

  private get apiKey(): string {
    const key = this.env.BUFFER_API_KEY;
    if (!key) throw new Error("BUFFER_API_KEY not configured");
    return key;
  }

  /** One JSON-RPC round trip; parses JSON or SSE-framed responses. */
  private async rpc(
    method: string,
    params?: Record<string, unknown>,
    isNotification = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (!isNotification) body.id = this.nextId++;
    if (params) body.params = params;

    const res = await fetch(BUFFER_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const issuedSession = res.headers.get("Mcp-Session-Id");
    if (issuedSession) this.sessionId = issuedSession;

    if (!res.ok) {
      throw new Error(
        `Buffer MCP ${method} failed ${res.status}: ${(await res.text()).substring(0, 300)}`,
      );
    }
    if (isNotification || res.status === 202) return undefined;

    const contentType = res.headers.get("Content-Type") ?? "";
    let message: JsonRpcResponse | undefined;
    if (contentType.includes("text/event-stream")) {
      // SSE framing: take the last data: frame carrying a JSON-RPC message.
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            message = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
          } catch {
            /* keep scanning */
          }
        }
      }
    } else {
      message = (await res.json()) as JsonRpcResponse;
    }

    if (!message) throw new Error(`Buffer MCP ${method}: unparseable response`);
    if (message.error) {
      throw new Error(
        `Buffer MCP ${method} error ${message.error.code}: ${message.error.message}`,
      );
    }
    return message.result;
  }

  /** Initialize handshake (protocol 2025-03-26), once per client instance. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "discord-buffer-agent", version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", {}, true);
    this.initialized = true;
  }

  /** Call any MCP tool; returns the parsed JSON payload of its text content. */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.initialize();
    const result = (await this.rpc("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;

    if (result?.isError) {
      const text = result.content?.find((c) => c.type === "text")?.text ?? "";
      throw new Error(`Buffer MCP tool ${name} returned an error: ${text.substring(0, 300)}`);
    }
    const text = result?.content?.find((c) => c.type === "text")?.text;
    if (text === undefined) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async listTools(): Promise<unknown> {
    await this.initialize();
    return this.rpc("tools/list", {});
  }

  // ---------------------------------------------------------------
  // Named tools (docs: developers.buffer.com/guides/integrations/mcp)
  // ---------------------------------------------------------------

  async getAccount(): Promise<unknown> {
    return this.callTool("get_account");
  }

  async listChannels(): Promise<unknown> {
    return this.callTool("list_channels");
  }

  async listPosts(args: Record<string, unknown> = {}): Promise<unknown> {
    return this.callTool("list_posts", args);
  }

  async getPost(args: Record<string, unknown>): Promise<unknown> {
    return this.callTool("get_post", args);
  }

  async createPost(args: Record<string, unknown>): Promise<unknown> {
    return this.callTool("create_post", args);
  }

  async editPost(args: Record<string, unknown>): Promise<unknown> {
    return this.callTool("edit_post", args);
  }

  async deletePost(args: Record<string, unknown>): Promise<unknown> {
    return this.callTool("delete_post", args);
  }

  async listIdeas(args: Record<string, unknown> = {}): Promise<unknown> {
    return this.callTool("list_ideas", args);
  }

  async listTemplates(args: Record<string, unknown> = {}): Promise<unknown> {
    return this.callTool("list_templates", args);
  }

  async getMetrics(args: Record<string, unknown> = {}): Promise<unknown> {
    return this.callTool("get_metrics", args);
  }

  // ---------------------------------------------------------------
  // Advanced trio — the full GraphQL API through the MCP server.
  // These are what make the MCP rail a superset of the fallback rail:
  // every ContentItem operation in queries.ts runs through them.
  // ---------------------------------------------------------------

  async introspectSchema(args: Record<string, unknown> = {}): Promise<unknown> {
    return this.callTool("introspect_schema", args);
  }

  async executeQuery(query: string): Promise<unknown> {
    return this.callTool("execute_query", { query });
  }

  async executeMutation(mutation: string): Promise<unknown> {
    return this.callTool("execute_mutation", { mutation });
  }
}

/**
 * Unwrap a GraphQL payload from an execute_query / execute_mutation tool
 * result into the same shape the fallback rail returns (first field of
 * `data`). Tolerant of the tool returning either the GraphQL envelope or
 * the data object directly — the exact envelope is on the build-week-1
 * live-confirmation list.
 */
export function unwrapGraphqlToolResult<T>(payload: unknown): T {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.errors) && obj.errors.length) {
      const first = obj.errors[0] as { message?: string };
      throw new Error(`Buffer GraphQL error: ${first?.message || "unknown error"}`);
    }
    if (obj.data && typeof obj.data === "object") {
      return Object.values(obj.data as Record<string, T>)[0];
    }
  }
  return payload as T;
}
