// A minimal MCP server over stdio, dependency-free.
//
// The stdio transport is newline-delimited JSON-RPC 2.0: one JSON message per
// line on stdin, one per line on stdout. Nothing else may be written to stdout —
// diagnostics go to stderr.
//
// Implements the subset of the protocol a tools-only server needs: initialize,
// tools/list, tools/call, ping. Mirrors the API of @modelcontextprotocol/sdk's
// McpServer closely enough that server.js runs against either one unchanged.

import { shapeToJsonSchema, applyShape } from "./zod-lite.mjs";

const PROTOCOL_VERSION = "2024-11-05";

export class McpServer {
  constructor(info) {
    this.info = info ?? { name: "mcp-server", version: "0.0.0" };
    this.tools = new Map();
  }

  tool(name, description, shape, handler) {
    this.tools.set(name, { name, description, shape, handler });
  }

  async connect(transport) {
    await transport.start(this);
  }

  listTools() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: shapeToJsonSchema(t.shape),
    }));
  }

  async callTool(name, args) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const parsed = applyShape(tool.shape, args);
    return await tool.handler(parsed);
  }

  async handle(msg) {
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: this.info,
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.listTools() };
      case "tools/call": {
        try {
          return await this.callTool(msg.params?.name, msg.params?.arguments);
        } catch (err) {
          // Tool failures are reported in-band so the model can read and react
          // to them, rather than as transport-level JSON-RPC errors.
          return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
        }
      }
      default: {
        const e = new Error(`Method not found: ${msg.method}`);
        e.code = -32601;
        throw e;
      }
    }
  }
}

export class StdioServerTransport {
  async start(server) {
    let buffer = "";

    const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

    const dispatch = async (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      // Notifications carry no id and must never be answered.
      const isNotification = msg.id === undefined || msg.id === null;
      try {
        const result = await server.handle(msg);
        if (!isNotification) write({ jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        if (!isNotification) {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: err?.code ?? -32603, message: String(err?.message ?? err) },
          });
        }
      }
    };

    // Serialize dispatch so responses cannot interleave mid-line on stdout.
    let queue = Promise.resolve();

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) queue = queue.then(() => dispatch(line));
      }
    });

    process.stdin.on("end", () => {
      queue.then(() => process.exit(0));
    });

    // Keep the process alive while attached to stdin.
    process.stdin.resume();
  }
}
