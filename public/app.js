const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let currentState = null;
let toastTimer = null;
let selectedSessionId = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.requestId = data.requestId;
    throw error;
  }
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function setStatus(selector, text, kind = "") {
  const element = $(selector);
  element.textContent = text;
  element.className = `status ${kind}`;
}

function unlock(step) {
  $(`#step-${step}`).classList.remove("locked");
}

function renderState(state) {
  currentState = state;
  if (state.configured) {
    unlock(2);
    $("[data-jump='1']").classList.add("done");
    setStatus("#config-status", "✓ API Key 已验证", "success");
  }
  if (state.agent) $("#agent-id").textContent = `${state.agent.id} · v${state.agent.version}`;
  if (state.environment) $("#environment-id").textContent = state.environment.id;
  if (state.agent && state.environment) {
    unlock(3);
    $("[data-jump='2']").classList.add("done");
    setStatus("#provision-status", "✓ 初始化完成", "success");
    $("#provision").textContent = "资源已就绪";
    $("#provision").disabled = true;
  }
  if (state.workdir) {
    $("#directory-name").textContent = state.workdir.split("/").filter(Boolean).pop() || state.workdir;
    $("#directory-path").textContent = state.workdir;
    $("#start-worker").disabled = false;
  }
  if (state.worker?.running) {
    unlock(4);
    $("[data-jump='3']").classList.add("done");
    $("#worker-dot").classList.add("online");
    $("#worker-title").textContent = "Worker 运行中";
    $("#worker-subtitle").textContent = "正在出站轮询 Work Queue";
    $("#start-worker").textContent = "Worker 已启动";
    $("#start-worker").disabled = true;
  } else {
    $("#worker-dot").classList.remove("online");
    if (state.worker?.exit) {
      $("#worker-title").textContent = "Worker 已退出";
      $("#worker-subtitle").textContent = `code ${state.worker.exit.code ?? "-"}`;
      $("#start-worker").textContent = "重新启动";
      $("#start-worker").disabled = !state.workdir;
    }
  }
  if (Array.isArray(state.logs)) renderLogs(state.logs);
  if (Array.isArray(state.sessions)) renderSessionHistory(state.sessions);
}

function sessionStatusLabel(status) {
  return ({
    running: "运行中",
    "session.status_idle": "已完成",
    "session.status_terminated": "已终止",
    "session.error": "失败",
    timed_out: "观测超时",
  })[status] || status || "未知";
}

function sessionTime(session) {
  const value = session.completedAt || session.updatedAt || session.createdAt;
  return value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "";
}

function renderSession(session) {
  selectedSessionId = session?.id || null;
  const conversation = $("#conversation");
  conversation.innerHTML = "";
  if (!session) {
    conversation.className = "conversation empty";
    conversation.innerHTML = '<div class="empty-chat"><span>✦</span><p>选择一个示例，或输入你自己的任务</p></div>';
    return;
  }
  conversation.className = "conversation";
  if (session.message) bubble("user", session.message);
  if (session.reply) {
    bubble("agent", session.reply);
  } else if (session.status === "running") {
    bubble("agent", "方舟正在编排，本地 Worker 正在执行", "loading");
  } else {
    bubble("agent", session.status === "session.error" ? "Session 执行失败，请结合事件与 Worker 日志排查。" : "Session 已结束，但没有返回文本。");
  }
  const eventCount = Array.isArray(session.events) ? session.events.length : 0;
  bubble("system", `Session ${session.id} · ${sessionStatusLabel(session.status)} · ${eventCount} 个事件`);
  refreshArtifacts(session.artifacts || []).catch((error) => toast(error.message));
}

function renderSessionHistory(sessions) {
  const wrapper = $("#session-history");
  const list = $("#session-list");
  list.innerHTML = "";
  if (!sessions.length) {
    wrapper.classList.add("hidden");
    if (!selectedSessionId) renderSession(null);
    return;
  }
  wrapper.classList.remove("hidden");
  const selected = sessions.find((item) => item.id === selectedSessionId) || sessions[0];
  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-chip${session.id === selected.id ? " active" : ""}`;
    const title = document.createElement("span");
    title.textContent = session.message || session.id;
    const meta = document.createElement("small");
    meta.textContent = `${sessionStatusLabel(session.status)} · ${sessionTime(session)}`;
    button.append(title, meta);
    button.addEventListener("click", () => {
      renderSession(session);
      renderSessionHistory(sessions);
    });
    list.appendChild(button);
  }
  renderSession(selected);
  if (selected.status !== "running") $("[data-jump='4']").classList.add("done");
}

function renderLogs(logs) {
  const text = logs.map((item) => {
    const time = new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false });
    return `[${time}] ${item.payload?.text || ""}`;
  }).filter(Boolean).join("\n");
  $("#worker-logs").textContent = text || "等待 Worker 启动…";
  $("#worker-logs").scrollTop = $("#worker-logs").scrollHeight;
}

function appendLog(item) {
  if (!currentState) return;
  currentState.logs = [...(currentState.logs || []), item].slice(-80);
  renderLogs(currentState.logs);
}

function bubble(kind, text, extraClass = "") {
  const conversation = $("#conversation");
  if (conversation.classList.contains("empty")) {
    conversation.classList.remove("empty");
    conversation.innerHTML = "";
  }
  const element = document.createElement("div");
  element.className = `bubble ${kind} ${extraClass}`;
  element.textContent = text;
  conversation.appendChild(element);
  conversation.scrollTop = conversation.scrollHeight;
  return element;
}

async function refreshArtifacts(items) {
  if (!items) items = (await api("/api/artifacts")).data;
  const wrapper = $("#artifacts");
  const list = $("#artifact-list");
  list.innerHTML = "";
  if (!items.length) {
    wrapper.classList.add("hidden");
    return;
  }
  wrapper.classList.remove("hidden");
  for (const item of items) {
    const link = document.createElement("a");
    link.className = "artifact";
    link.target = "_blank";
    link.rel = "noopener";
    link.href = `/api/artifact?path=${encodeURIComponent(item.path)}`;
    const name = document.createElement("span");
    name.textContent = item.path;
    const size = document.createElement("small");
    size.textContent = item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KB`;
    link.append(name, size);
    list.appendChild(link);
  }
}

$("#toggle-key").addEventListener("click", () => {
  const input = $("#api-key");
  input.type = input.type === "password" ? "text" : "password";
  $("#toggle-key").textContent = input.type === "password" ? "显示" : "隐藏";
});

$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  setStatus("#config-status", "正在连接方舟…");
  try {
    const result = await api("/api/config", {
      method: "POST",
      body: { apiKey: $("#api-key").value, baseUrl: $("#base-url").value, modelId: $("#model-id").value },
    });
    $("#api-key").value = "";
    renderState(result.state);
    $("#step-2").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    setStatus("#config-status", `${error.message}${error.requestId ? ` · ${error.requestId}` : ""}`, "error");
  } finally { button.disabled = false; }
});

$("#provision").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "初始化中…";
  setStatus("#provision-status", "先创建 Agent，再创建 Environment");
  try {
    const result = await api("/api/provision", { method: "POST" });
    renderState(result.state);
    $("#step-3").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    button.disabled = false;
    button.textContent = "继续初始化";
    setStatus("#provision-status", `${error.message}${error.requestId ? ` · ${error.requestId}` : ""}`, "error");
  }
});

$("#choose-directory").addEventListener("click", async () => {
  try {
    const result = await api("/api/select-directory", { method: "POST" });
    currentState.workdir = result.path;
    renderState(currentState);
  } catch (error) { if (error.message !== "已取消选择") toast(error.message); }
});

$("#start-worker").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在启动…";
  $("#worker-title").textContent = "准备 Go SDK";
  $("#worker-subtitle").textContent = "首次启动可能需要拉取并编译依赖";
  try {
    const result = await api("/api/worker/start", { method: "POST" });
    renderState(result.state);
    $("#step-4").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    button.disabled = false;
    button.textContent = "重新启动";
    toast(error.message);
  }
});

$$('.suggestions button').forEach((button) => button.addEventListener("click", () => {
  $("#message").value = button.textContent.trim();
  $("#message").focus();
}));

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#message").value.trim();
  if (!message) return;
  const send = $(".send");
  send.disabled = true;
  $("#message").value = "";
  bubble("user", message);
  const loading = bubble("agent", "方舟正在编排，本地 Worker 正在执行", "loading");
  try {
    const result = await api("/api/chat", { method: "POST", body: { message } });
    loading.classList.remove("loading");
    loading.textContent = result.reply || `Session 已结束（${result.terminal}），但没有返回文本。`;
    bubble("system", `Session ${result.sessionId} · ${result.terminal}`);
    $("[data-jump='4']").classList.add("done");
    await refreshArtifacts(result.artifacts);
    const nextState = await api("/api/state");
    renderState(nextState);
  } catch (error) {
    loading.classList.remove("loading");
    loading.textContent = `执行失败：${error.message}${error.requestId ? `\nRequest ID: ${error.requestId}` : ""}`;
  } finally { send.disabled = false; }
});

$("#refresh-artifacts").addEventListener("click", () => refreshArtifacts().catch((error) => toast(error.message)));
$$('[data-jump]').forEach((button) => button.addEventListener("click", () => {
  $(`#step-${button.dataset.jump}`).scrollIntoView({ behavior: "smooth", block: "center" });
}));

const stream = new EventSource("/api/events");
stream.addEventListener("state", (event) => renderState(JSON.parse(event.data).payload));
stream.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
stream.addEventListener("session-event", (event) => {
  const type = JSON.parse(event.data).payload.type;
  if (type === "agent.tool_use") $(".bubble.loading")?.replaceChildren(document.createTextNode("本地 Worker 正在执行工具调用"));
});
stream.onerror = () => toast("与本地服务的状态连接暂时中断");

api("/api/state").then(renderState).catch((error) => toast(error.message));
