import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveTransportConfig, startStreamableHttpServer } from "@/streamableHttp.js";

describe("resolveTransportConfig", () => {
  it("keeps stdio as the default", () => {
    expect(resolveTransportConfig([], {})).toEqual({ kind: "stdio" });
  });

  it("resolves Streamable HTTP options from arguments and environment", () => {
    expect(
      resolveTransportConfig(
        ["--transport", "streamable-http", "--host=::1", "--port", "0", "--endpoint", "/mail"],
        { APPLE_MAIL_MCP_HTTP_API_KEY: "secret" }
      )
    ).toEqual({
      apiKey: "secret",
      endpoint: "/mail",
      host: "::1",
      kind: "streamable-http",
      port: 0,
    });
  });

  it("requires authentication for a non-loopback binding", () => {
    expect(() => resolveTransportConfig(["--transport", "http", "--host", "0.0.0.0"], {})).toThrow(
      "APPLE_MAIL_MCP_HTTP_API_KEY is required"
    );
  });

  it("rejects invalid ports and endpoints", () => {
    expect(() => resolveTransportConfig(["--transport", "http", "--port", "70000"], {})).toThrow(
      "Invalid Streamable HTTP port"
    );
    expect(() => resolveTransportConfig(["--transport", "http", "--endpoint", "mcp"], {})).toThrow(
      "Invalid Streamable HTTP endpoint"
    );
  });
});

describe("startStreamableHttpServer", () => {
  it("serves independent authenticated MCP sessions and a health endpoint", async () => {
    const created: McpServer[] = [];
    const closed: McpServer[] = [];
    const httpServer = await startStreamableHttpServer({
      apiKey: "test-key",
      createServer: () => {
        const server = createTestServer();
        created.push(server);
        return server;
      },
      endpoint: "/mcp",
      host: "127.0.0.1",
      kind: "streamable-http",
      onServerClosed: (server) => closed.push(server),
      port: 0,
    });

    try {
      const unauthorizedHealth = await fetch(new URL("/health", httpServer.url));
      expect(unauthorizedHealth.status).toBe(401);

      const health = await fetch(new URL("/health", httpServer.url), {
        headers: { "X-API-Key": "test-key" },
      });
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: "ok" });

      const unauthorized = await fetch(httpServer.url, { method: "POST" });
      expect(unauthorized.status).toBe(401);

      const clients = await Promise.all([
        connectClient("client-one", httpServer.url),
        connectClient("client-two", httpServer.url),
      ]);
      expect(created).toHaveLength(2);

      for (const { client } of clients) {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("echo");
        const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
        expect(result.content).toEqual([{ type: "text", text: "hello" }]);
      }

      await Promise.all(clients.map(async ({ transport }) => await transport.terminateSession()));
      expect(closed).toHaveLength(2);
      await Promise.all(clients.map(async ({ client }) => await client.close()));
    } finally {
      await httpServer.close();
    }
  });

  it("rejects browser-origin requests", async () => {
    const httpServer = await startStreamableHttpServer({
      createServer: createTestServer,
      endpoint: "/mcp",
      host: "127.0.0.1",
      kind: "streamable-http",
      port: 0,
    });
    try {
      const response = await fetch(httpServer.url, {
        headers: { origin: "https://attacker.example" },
        method: "POST",
      });
      expect(response.status).toBe(403);
    } finally {
      await httpServer.close();
    }
  });
});

function createTestServer(): McpServer {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ text, type: "text" }],
  }));
  return server;
}

async function connectClient(name: string, url: URL) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { "X-API-Key": "test-key" } },
  });
  await client.connect(transport);
  return { client, transport };
}
