import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-billion-memory-e2e-"));
fs.mkdirSync(path.join(tmpHome, ".pi"), { recursive: true });
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

let shutdownHandler = null;
let ctx = null;

try {
  const { default: factory } = await import("../../dist/index.js");
  assert.equal(typeof factory, "function", "dist/index.js must default-export the pi extension factory");

  const registrations = [];
  const handlers = new Map();
  const notifications = [];
  const mockPi = {
    on(event, handler) {
      registrations.push(`on:${event}`);
      handlers.set(event, handler);
      assert.equal(typeof handler, "function", `handler for ${event} must be a function`);
    },
    registerTool(tool) {
      registrations.push(`tool:${tool.name}`);
      assert.equal(typeof tool.execute, "function", "registered tool must have an execute function");
    },
    registerCommand(name, command) {
      registrations.push(`command:${name}`);
      handlers.set(`command:${name}`, command.handler);
    },
  };

  await factory(mockPi);

  const expected = [
    "on:session_start",
    "on:agent_settled",
    "on:session_shutdown",
    "tool:memory_search",
    "command:memory",
  ];
  assert.deepEqual(registrations, expected, `unexpected registrations: ${registrations.join(", ")}`);

  shutdownHandler = handlers.get("session_shutdown");
  ctx = {
    cwd: tmpHome,
    ui: { notify: (msg, level) => notifications.push({ msg, level }) },
    sessionManager: { getSessionFile: () => null },
  };

  const command = handlers.get("command:memory");
  assert.equal(typeof command, "function", "command handler must be registered");
  await command("status", ctx);

  assert.equal(notifications.length, 1, "memory status should notify exactly once");
  assert.match(notifications[0].msg, /Memory store:/, "memory status should report the store");
  assert.ok(
    fs.existsSync(path.join(tmpHome, ".pi", "pi-billion-memory.db")),
    "memory status should open the SQLite store through node:sqlite",
  );

  console.log(`e2e ok: ${registrations.join(", ")}; node:sqlite store opened`);
} finally {
  if (shutdownHandler && ctx) {
    try {
      await shutdownHandler({}, ctx);
    } catch {
      // best-effort close before removing the temporary home
    }
  }
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
