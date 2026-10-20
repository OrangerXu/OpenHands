// @vitest-environment node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import WebSocket from "ws";
import {
  CLOSE_GUEST_DIAL_FAILED,
  CLOSE_SESSION_UNAVAILABLE,
  PAUSED,
  PLACEHOLDER_TOKEN,
  PROVISIONING,
  READY,
  createStandin,
} from "./digitalocean-standin.mjs";

const FIXTURE = fileURLToPath(
  new URL("./digitalocean-standin.mjs", import.meta.url),
);
const AUTH = { Authorization: `Bearer ${PLACEHOLDER_TOKEN}` };
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

/** A sandbox agent-server stand-in that answers /server_info. */
async function startGuest() {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/server_info" ? 200 : 404, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ title: "guest", path: req.url }));
  });
  const port = await listen(server);
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${port}`;
}

async function start({ wakeMs = 20 } = {}) {
  const calls = [];
  const { server, close } = createStandin({
    guestUrl: await startGuest(),
    wakeMs,
    record: (entry) => calls.push(entry),
  });
  const port = await listen(server);
  cleanups.push(close);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, headers = AUTH) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { base, call, calls };
}

const until = async (check) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
};

test("accepts only the placeholder token, so a real one is refused like a wrong one", async () => {
  const { call } = await start();
  const realLooking = `dop_v1_${"a1".repeat(32)}`;

  assert.equal(
    (await call("GET", "/v2/agents/configs", undefined, {})).status,
    401,
  );
  assert.equal(
    (
      await call("GET", "/v2/agents/configs", undefined, {
        Authorization: `Bearer ${realLooking}`,
      })
    ).status,
    401,
  );
  const list = await call("GET", "/v2/agents/configs");
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.configs.map((c) => [c.id, "manifest" in c]),
    [
      ["cfg_standin", false],
      ["cfg_other", false],
    ],
  );
  const one = await call("GET", "/v2/agents/configs/cfg_standin");
  assert.equal(one.body.config.manifest.agent, "openhands");
  assert.equal(
    (await call("GET", "/v2/account")).body.account.team.name,
    "Stand-in team",
  );
});

test("creates, wakes, pauses and destroys sessions the way Canvas reads them", async () => {
  const { call } = await start();
  const created = await call("POST", "/v2/agents/sessions", {
    name: "qa-new",
    config_id: "cfg_standin",
  });
  assert.equal(created.body.session.status, PROVISIONING);
  const id = created.body.session.session_id;
  const status = async () =>
    (await call("GET", `/v2/agents/sessions/${id}`)).body.session?.status;
  await until(async () => (await status()) === READY);

  await call("POST", `/v2/agents/sessions/${id}/pause`);
  assert.equal(await status(), PAUSED);
  await call("POST", `/v2/agents/sessions/${id}/resume`);
  await until(async () => (await status()) === READY);

  const sessions = await call("GET", "/v2/agents/configs/cfg_standin/sessions");
  assert.ok(sessions.body.sessions.some((s) => s.session_id === id));
  assert.equal((await call("DELETE", `/v2/agents/sessions/${id}`)).status, 200);
  assert.equal((await call("GET", `/v2/agents/sessions/${id}`)).status, 404);

  const config = await call("POST", "/v2/agents/configs", {
    name: "qa-agent",
    manifest_yaml: "agent: openhands\ntemplate: openhands\nkeep_warm: false\n",
  });
  const full = await call("GET", `/v2/agents/configs/${config.body.config.id}`);
  assert.equal(full.body.config.manifest.agent, "openhands");
});

/** Opens a tunnel; resolves with what the sandbox sent back, or the close code. */
function tunnel(base, path, headers = AUTH) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}${path}`, {
      headers,
    });
    let received = "";
    ws.on("unexpected-response", (_req, res) =>
      resolve({ httpStatus: res.statusCode }),
    );
    ws.on("open", () => {
      ws.send(
        "GET /server_info HTTP/1.1\r\nHost: guest\r\nConnection: close\r\n\r\n",
      );
    });
    ws.on("message", (data) => {
      received += data.toString();
    });
    ws.on("close", (code) => resolve({ code, received }));
  });
}

test("tunnels a ready session's guest port to the sandbox, and refuses the rest", async () => {
  const { base, calls } = await start();

  const open = await tunnel(
    base,
    "/v2/agents/sessions/sess_ready/port-forward/8000",
  );
  assert.match(open.received, /^HTTP\/1\.1 200/);
  assert.match(open.received, /"title":"guest"/);

  assert.equal(
    (await tunnel(base, "/v2/agents/sessions/sess_paused/port-forward/8000"))
      .code,
    CLOSE_SESSION_UNAVAILABLE,
  );
  assert.equal(
    (await tunnel(base, "/v2/agents/sessions/sess_ready/port-forward/3000"))
      .code,
    CLOSE_GUEST_DIAL_FAILED,
  );
  assert.equal(
    (await tunnel(base, "/v2/agents/sessions/sess_ready/port-forward/8000", {}))
      .httpStatus,
    401,
  );
  assert.deepEqual(
    calls.filter((c) => c.method === "TUNNEL").map((c) => c.status),
    [101, CLOSE_SESSION_UNAVAILABLE, CLOSE_GUEST_DIAL_FAILED, 401],
  );
});

test("points the run at itself while it runs, and puts the run back when stopped", async () => {
  const run = mkdtempSync(join(tmpdir(), "oh-do-standin-"));
  mkdirSync(join(run, "private"));
  const envFile = join(run, "private", "launcher-env.json");
  writeFileSync(
    envFile,
    JSON.stringify({ PATH: process.env.PATH, KEEP: "me" }),
  );
  const child = spawn(
    process.execPath,
    [
      FIXTURE,
      "--run",
      run,
      "--guest-url",
      await startGuest(),
      "--seconds",
      "60",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(() => child.exitCode === null && child.kill("SIGKILL"));
  const ready = await new Promise((resolve) => {
    child.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk))));
  });

  assert.equal(ready.ok, true);
  assert.equal(
    JSON.parse(readFileSync(envFile, "utf8")).MARS_API_BASE_URL,
    ready.baseUrl,
  );
  const metadata = join(run, "private", "digitalocean-standin", "standin.json");
  assert.equal(statSync(metadata).mode & 0o777, 0o600);
  assert.equal((await fetch(`${ready.baseUrl}/__standin/state`)).status, 200);

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  const env = JSON.parse(readFileSync(envFile, "utf8"));
  assert.equal(env.MARS_API_BASE_URL, undefined);
  assert.equal(env.KEEP, "me");
  assert.ok(JSON.parse(readFileSync(metadata, "utf8")).stoppedAt);
});

test("stops on SIGTERM while a tunnel is open", async () => {
  const run = mkdtempSync(join(tmpdir(), "oh-do-standin-"));
  mkdirSync(join(run, "private"));
  const envFile = join(run, "private", "launcher-env.json");
  writeFileSync(envFile, JSON.stringify({ PATH: process.env.PATH }));
  const child = spawn(
    process.execPath,
    [
      FIXTURE,
      "--run",
      run,
      "--guest-url",
      await startGuest(),
      "--seconds",
      "60",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(() => child.exitCode === null && child.kill("SIGKILL"));
  const ready = await new Promise((resolve) => {
    child.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk))));
  });
  const ws = new WebSocket(
    `${ready.baseUrl.replace("http", "ws")}/v2/agents/sessions/sess_ready/port-forward/8000`,
    { headers: AUTH },
  );
  cleanups.push(() => ws.terminate());
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.on("error", reject);
  });

  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(exited, "the stand-in is still running 5 s after SIGTERM");
  assert.equal(
    JSON.parse(readFileSync(envFile, "utf8")).MARS_API_BASE_URL,
    undefined,
  );
});
