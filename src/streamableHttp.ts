import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_ENDPOINT = "/mcp";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const HEALTH_ENDPOINT = "/health";
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export type StdioTransportConfig = {
  kind: "stdio";
};

export type StreamableHttpTransportConfig = {
  apiKey?: string;
  endpoint: string;
  host: string;
  kind: "streamable-http";
  port: number;
};

export type TransportConfig = StdioTransportConfig | StreamableHttpTransportConfig;

export type StreamableHttpServerOptions = StreamableHttpTransportConfig & {
  createServer: () => McpServer;
  onServerClosed?: (server: McpServer) => void;
  onServerCreated?: (server: McpServer) => void;
};

export type StreamableHttpServer = {
  close: () => Promise<void>;
  host: string;
  port: number;
  url: URL;
};

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

export function resolveTransportConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): TransportConfig {
  const transport = readArgument(args, "--transport") ?? env.APPLE_MAIL_MCP_TRANSPORT ?? "stdio";
  if (transport === "stdio") return { kind: "stdio" };
  if (transport !== "streamable-http" && transport !== "http") {
    throw new Error(`Unsupported transport "${transport}". Expected "stdio" or "streamable-http".`);
  }

  const host = readArgument(args, "--host") ?? env.APPLE_MAIL_MCP_HTTP_HOST ?? DEFAULT_HOST;
  const port = parsePort(
    readArgument(args, "--port") ?? env.APPLE_MAIL_MCP_HTTP_PORT ?? String(DEFAULT_PORT)
  );
  const endpoint = parseEndpoint(
    readArgument(args, "--endpoint") ?? env.APPLE_MAIL_MCP_HTTP_ENDPOINT ?? DEFAULT_ENDPOINT
  );
  const apiKey = env.APPLE_MAIL_MCP_HTTP_API_KEY?.trim() || undefined;
  if (!isLoopbackHost(host) && apiKey === undefined) {
    throw new Error(
      "APPLE_MAIL_MCP_HTTP_API_KEY is required when Streamable HTTP binds outside loopback."
    );
  }
  return { apiKey, endpoint, host, kind: "streamable-http", port };
}

export async function startStreamableHttpServer(
  options: StreamableHttpServerOptions
): Promise<StreamableHttpServer> {
  const sessions = new Map<string, Session>();
  const servers = new Set<McpServer>();
  let closing = false;

  const httpServer = createHttpServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (error instanceof HttpRequestError && !response.headersSent) {
        sendMcpError(response, error.statusCode, -32700, error.message);
        return;
      }
      console.error("Streamable HTTP request failed:", error);
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: { code: -32603, message: "Internal server error" },
          id: null,
          jsonrpc: "2.0",
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) {
      sendJson(response, 503, { status: "shutting-down" });
      return;
    }

    const pathname = requestPathname(request);
    if (pathname === HEALTH_ENDPOINT && request.method === "GET") {
      if (!isAuthorized(request, options.apiKey)) {
        response.setHeader("WWW-Authenticate", "ApiKey");
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (pathname !== options.endpoint) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (request.headers.origin !== undefined) {
      sendJson(response, 403, { error: "Browser-origin requests are not allowed" });
      return;
    }
    if (!isAuthorized(request, options.apiKey)) {
      response.setHeader("WWW-Authenticate", "ApiKey");
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    if (!isMcpMethod(request.method)) {
      response.setHeader("Allow", "GET, POST, DELETE");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const body = request.method === "POST" ? await readJsonBody(request) : undefined;
    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    const session = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (session !== undefined) {
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (sessionId !== undefined) {
      sendMcpError(response, 404, -32001, "Session not found");
      return;
    }
    if (request.method !== "POST" || !isInitializeRequest(body)) {
      sendMcpError(response, 400, -32000, "A valid initialize request is required");
      return;
    }

    const server = options.createServer();
    servers.add(server);
    options.onServerCreated?.(server);
    const transport = new StreamableHTTPServerTransport({
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
      sessionIdGenerator: randomUUID,
    });
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      servers.delete(server);
      options.onServerClosed?.(server);
    };
    transport.onclose = cleanup;
    transport.onerror = (error) => {
      console.error("Streamable HTTP transport failed:", error);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      cleanup();
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  await listen(httpServer, options.port, options.host);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("Streamable HTTP server did not expose a TCP address.");
  }
  const urlHost = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = new URL(options.endpoint, `http://${urlHost}:${address.port}`);

  return {
    async close() {
      if (closing) return;
      closing = true;
      await Promise.allSettled([...servers].map(async (server) => await server.close()));
      sessions.clear();
      await closeHttpServer(httpServer);
    },
    host: options.host,
    port: address.port,
    url,
  };
}

function readArgument(args: string[], name: string): string | undefined {
  const inlinePrefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(inlinePrefix));
  if (inline !== undefined) return inline.slice(inlinePrefix.length);
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid Streamable HTTP port "${value}".`);
  }
  return port;
}

function parseEndpoint(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error(`Invalid Streamable HTTP endpoint "${value}".`);
  }
  if (value === HEALTH_ENDPOINT) {
    throw new Error(`${HEALTH_ENDPOINT} is reserved for health checks.`);
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function requestPathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function isMcpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "POST" || method === "DELETE";
}

function isAuthorized(request: IncomingMessage, expectedKey: string | undefined): boolean {
  if (expectedKey === undefined) return true;
  const providedKey = singleHeader(request.headers["x-api-key"]);
  if (providedKey === undefined) return false;
  const expected = Buffer.from(expectedKey);
  const provided = Buffer.from(providedKey);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpRequestError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpRequestError(400, "Request body must be valid JSON");
  }
}

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function sendMcpError(
  response: ServerResponse,
  statusCode: number,
  code: number,
  message: string
): void {
  sendJson(response, statusCode, {
    error: { code, message },
    id: null,
    jsonrpc: "2.0",
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server: HttpServer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}
