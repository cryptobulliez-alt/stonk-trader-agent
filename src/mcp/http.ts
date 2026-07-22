#!/usr/bin/env node
import "dotenv/config";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createStonkBrokerMcpServer } from "./server.js";

const PORT = Number(process.env.MCP_PORT || 8787);

/**
 * Streamable HTTP MCP (same transport style as remote agent dashboards).
 * Point an MCP client at http://127.0.0.1:8787/mcp
 *
 * Stateless: new server+transport per request (safe behind load balancers).
 */
async function main() {
  const httpServer = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "stonk-trader",
          mcp: "/mcp",
          docs: "StonkBrokers MCP on Robinhood Chain — prepare_* returns unsigned calldata only",
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("not found");
      return;
    }

    const server = createStonkBrokerMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.listen(PORT, () => {
    console.error(`stonk-trader MCP listening on http://127.0.0.1:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
