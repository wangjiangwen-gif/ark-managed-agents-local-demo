import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoServer, createState, safeArtifactPath } from "../server.mjs";

const TEST_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(state, run) {
  const { server } = createDemoServer({ state });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function withUpstream(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function json(response, data, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}

test("health endpoint responds without configuration", async () => {
  await withServer(createState(), async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("page includes in-process Session history, live timeline and visible composer", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(join(TEST_ROOT, "public", "index.html"), "utf8"),
    readFile(join(TEST_ROOT, "public", "app.js"), "utf8"),
    readFile(join(TEST_ROOT, "public", "styles.css"), "utf8"),
  ]);
  assert.match(html, /id="session-history"/);
  assert.match(html, /id="restart-demo"/);
  assert.match(html, /当前服务进程内保留/);
  assert.match(script, /renderSessionHistory\(state\.sessions\)/);
  assert.match(script, /renderEventTimeline\(session\.events\)/);
  assert.match(script, /waitForRestart\(\)/);
  assert.match(script, /Session .* 个事件/);
  assert.match(styles, /\.composer \{ position: sticky;/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) 44px/);
});

test("restart endpoint stops Worker and invokes supervised restart", async () => {
  const state = createState();
  let stopped = false;
  state.worker = { exitCode: null, kill(signal) { stopped = signal === "SIGTERM"; this.exitCode = 0; } };
  let restarted = false;
  const { server } = createDemoServer({ state, onRestart: () => { restarted = true; } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/restart`, { method: "POST" });
    assert.equal(response.status, 202);
    assert.equal(stopped, true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(restarted, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("restart endpoint explains that start.sh supervision is required", async () => {
  await withServer(createState(), async (base) => {
    const response = await fetch(`${base}/api/restart`, { method: "POST" });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /start\.sh/);
  });
});

test("public state never exposes API key", async () => {
  const state = createState();
  state.apiKey = "ark-super-secret";
  await withServer(state, async (base) => {
    const response = await fetch(`${base}/api/state`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes("ark-super-secret"), false);
    assert.equal(JSON.parse(text).configured, true);
  });
});

test("public state restores recent Session observation without exposing credentials", async () => {
  const state = createState({ sessions: [{
    id: "session-old",
    status: "session.status_idle",
    message: "创建 HTML",
    reply: "已完成",
    events: [{ id: "evt-1", type: "agent.message", text: "已完成" }],
    artifacts: [{ path: "session-old/demo.html", size: 12 }],
  }] });
  state.apiKey = "ark-private";
  await withServer(state, async (base) => {
    const response = await fetch(`${base}/api/state`);
    const payload = await response.json();
    assert.equal(payload.session.id, "session-old");
    assert.equal(payload.sessions[0].message, "创建 HTML");
    assert.equal(JSON.stringify(payload).includes("ark-private"), false);

    const detail = await fetch(`${base}/api/sessions/session-old`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.reply, "已完成");
  });
});

test("configuration rejects an empty API key before network access", async () => {
  await withServer(createState(), async (base) => {
    const response = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /不能为空/);
  });
});

test("artifact path rejects traversal and accepts a child path", () => {
  assert.throws(() => safeArtifactPath("/tmp/demo-root", "../secret"), /非法文件路径/);
  assert.equal(safeArtifactPath("/tmp/demo-root", "slides/demo.html"), "/tmp/demo-root/slides/demo.html");
});

test("worker cannot start before environment and directory exist", async () => {
  const state = createState();
  state.apiKey = "test";
  await withServer(state, async (base) => {
    const response = await fetch(`${base}/api/worker/start`, { method: "POST" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Environment/);
  });
});

test("provision creates Agent first and then self-hosted Environment", async () => {
  const calls = [];
  await withUpstream((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, "Bearer test-key");
    if (request.url === "/agents" && request.method === "POST") {
      return json(response, { id: "agent-1", version: 1, name: "demo-agent" });
    }
    if (request.url === "/environments" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      return request.on("end", () => {
        assert.equal(JSON.parse(body).config.type, "self_hosted");
        json(response, { id: "env-1", name: "demo-env", config: { type: "self_hosted" } });
      });
    }
    json(response, { message: "unexpected" }, 404);
  }, async (upstream) => {
    const state = createState();
    state.apiKey = "test-key";
    state.baseUrl = upstream;
    await withServer(state, async (base) => {
      const response = await fetch(`${base}/api/provision`, { method: "POST" });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.state.agent.id, "agent-1");
      assert.equal(payload.state.environment.id, "env-1");
    });
  });
  assert.deepEqual(calls, ["POST /agents", "POST /environments"]);
});

test("chat creates Session, sends user.message and waits for idle", async () => {
  const calls = [];
  await withUpstream((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === "/sessions" && request.method === "POST") {
      return json(response, { id: "session-1" });
    }
    if (request.url === "/sessions/session-1/events" && request.method === "POST") {
      return json(response, { data: [] });
    }
    if (request.url === "/sessions/session-1/events?limit=100" && request.method === "GET") {
      return json(response, { data: [
        { id: "evt-1", type: "agent.message", content: [{ type: "text", text: "已在本地创建 ma-local.html" }] },
        { id: "evt-2", type: "session.status_idle" },
      ] });
    }
    json(response, { message: "unexpected" }, 404);
  }, async (upstream) => {
    const state = createState();
    state.apiKey = "test-key";
    state.baseUrl = upstream;
    state.agent = { id: "agent-1", version: 1 };
    state.environment = { id: "env-1" };
    state.worker = { exitCode: null, kill() { this.exitCode = 0; } };
    state.workdir = "/tmp/ark-local-demo-test-empty";
    await withServer(state, async (base) => {
      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "创建 HTML" }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.sessionId, "session-1");
      assert.equal(payload.terminal, "session.status_idle");
      assert.match(payload.reply, /ma-local\.html/);
      const statePayload = await (await fetch(`${base}/api/state`)).json();
      assert.equal(statePayload.sessions[0].id, "session-1");
      assert.equal(statePayload.sessions[0].message, "创建 HTML");
      assert.equal(statePayload.sessions[0].status, "session.status_idle");
      assert.match(statePayload.sessions[0].reply, /ma-local\.html/);
      assert.deepEqual(statePayload.sessions[0].events.map((event) => event.type), [
        "user.message",
        "agent.message",
        "session.status_idle",
      ]);
    });
  });
  assert.deepEqual(calls, [
    "POST /sessions",
    "POST /sessions/session-1/events",
    "GET /sessions/session-1/events?limit=100",
  ]);
});

test("chat preserves upstream Session error details for live observation", async () => {
  await withUpstream((request, response) => {
    if (request.url === "/sessions" && request.method === "POST") {
      return json(response, { id: "session-error" });
    }
    if (request.url === "/sessions/session-error/events" && request.method === "POST") {
      return json(response, { data: [] });
    }
    if (request.url === "/sessions/session-error/events?limit=100" && request.method === "GET") {
      return json(response, { data: [{
        id: "evt-error",
        type: "session.error",
        processed_at: "2026-09-03T05:00:00Z",
        error: { message: "工具结果处理失败" },
      }] });
    }
    json(response, { message: "unexpected" }, 404);
  }, async (upstream) => {
    const state = createState();
    state.apiKey = "test-key";
    state.baseUrl = upstream;
    state.agent = { id: "agent-1", version: 1 };
    state.environment = { id: "env-1" };
    state.worker = { exitCode: null, kill() { this.exitCode = 0; } };
    state.workdir = "/tmp/ark-local-demo-test-error";
    await withServer(state, async (base) => {
      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "触发错误" }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.terminal, "session.error");
      const observed = (await (await fetch(`${base}/api/state`)).json()).sessions[0];
      assert.equal(observed.status, "session.error");
      assert.equal(observed.events.at(-1).error, "工具结果处理失败");
    });
  });
});

test("chat ignores intermediate idle while a Tool Use is awaiting its result", async () => {
  let eventPoll = 0;
  await withUpstream((request, response) => {
    if (request.url === "/sessions" && request.method === "POST") return json(response, { id: "session-tools" });
    if (request.url === "/sessions/session-tools/events" && request.method === "POST") return json(response, { data: [] });
    if (request.url === "/sessions/session-tools/events?limit=100" && request.method === "GET") {
      eventPoll += 1;
      if (eventPoll === 1) {
        return json(response, { data: [
          { id: "call-1", type: "agent.tool_use", name: "bash" },
          { id: "idle-early", type: "session.status_idle" },
        ] });
      }
      return json(response, { data: [
        { id: "call-1", type: "agent.tool_use", name: "bash" },
        { id: "idle-early", type: "session.status_idle" },
        { id: "result-1", type: "user.tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "exit_code: 0" }] },
        { id: "message-1", type: "agent.message", content: [{ type: "text", text: "文件已生成" }] },
        { id: "idle-final", type: "session.status_idle" },
      ] });
    }
    json(response, { message: "unexpected" }, 404);
  }, async (upstream) => {
    const state = createState();
    state.apiKey = "test-key";
    state.baseUrl = upstream;
    state.agent = { id: "agent-1", version: 1 };
    state.environment = { id: "env-1" };
    state.worker = { exitCode: null, kill() { this.exitCode = 0; } };
    state.workdir = "/tmp/ark-local-demo-test-tools";
    await withServer(state, async (base) => {
      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "创建文件" }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(eventPoll, 2);
      assert.equal(payload.terminal, "session.status_idle");
      assert.equal(payload.reply, "文件已生成");
      const session = (await (await fetch(`${base}/api/state`)).json()).sessions[0];
      const earlyIdle = session.events.find((event) => event.id === "idle-early");
      assert.equal(earlyIdle.waitingForToolResult, true);
      assert.equal(session.events.at(-1).id, "idle-final");
    });
  });
});
