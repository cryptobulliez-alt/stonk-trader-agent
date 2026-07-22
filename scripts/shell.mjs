#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "apps", "web");

const kids = [];

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start, maxTries = 40) {
  for (let p = start; p < start + maxTries; p++) {
    if (await canListen(p)) return p;
  }
  throw new Error(`No free port found from ${start}–${start + maxTries - 1}`);
}

function run(cmd, args, cwd, name, env = {}) {
  const child = spawn(cmd, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      SHELL_URL: process.env.SHELL_URL || "http://127.0.0.1:8788",
      ...env,
    },
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => {
    console.log(`[${name}] exited ${code}`);
    for (const k of kids) {
      if (!k.killed) k.kill("SIGTERM");
    }
    process.exit(code ?? 1);
  });
  kids.push(child);
}

const preferred = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const webPort = await findFreePort(preferred);
if (webPort !== preferred) {
  console.log(`[web] port ${preferred} busy — using ${webPort}`);
}
console.log(`[web] http://localhost:${webPort}`);

run("npx", ["tsx", "src/shell/http.ts"], root, "shell-api");
run("npx", ["next", "dev", "-p", String(webPort), "-H", "127.0.0.1"], web, "web", {
  PORT: String(webPort),
});

function shutdown() {
  for (const k of kids) {
    if (!k.killed) k.kill("SIGTERM");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
