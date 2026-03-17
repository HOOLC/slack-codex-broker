import http from "node:http";
import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import type { AdminService } from "../services/admin-service.js";
import { readJsonBody, respondJson } from "./common.js";

export async function handleAdminRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly adminService: AdminService;
    readonly config: AppConfig;
  }
): Promise<boolean> {
  if (method === "GET" && url.pathname === "/admin") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderAdminPage({
      tokenConfigured: Boolean(options.config.brokerAdminToken),
      serviceName: options.config.serviceName
    }));
    return true;
  }

  if (!url.pathname.startsWith("/admin/api/")) {
    return false;
  }

  if (!isAuthorizedAdminRequest(request, options.config)) {
    respondJson(response, 401, {
      ok: false,
      error: "admin_auth_required"
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/status") {
    respondJson(response, 200, await options.adminService.getStatus());
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/replace-auth") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      respondJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }

    const authJsonContent = typeof body.auth_json_content === "string" ? body.auth_json_content : undefined;
    const credentialsJsonContent =
      typeof body.credentials_json_content === "string" ? body.credentials_json_content : undefined;
    const configTomlContent = typeof body.config_toml_content === "string" ? body.config_toml_content : undefined;
    const allowActive = body.allow_active === true;

    if (!authJsonContent?.trim()) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["auth_json_content"]
      });
      return true;
    }

    try {
      respondJson(
        response,
        200,
        await options.adminService.replaceAuthFiles({
          authJsonContent,
          credentialsJsonContent,
          configTomlContent,
          allowActive
        })
      );
    } catch (error) {
      respondJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return true;
  }

  return false;
}

function isAuthorizedAdminRequest(request: http.IncomingMessage, config: AppConfig): boolean {
  if (!config.brokerAdminToken) {
    return true;
  }

  const fromHeader = request.headers["x-admin-token"];
  if (typeof fromHeader === "string" && fromHeader === config.brokerAdminToken) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length) === config.brokerAdminToken;
  }

  return false;
}

function renderAdminPage(options: {
  readonly tokenConfigured: boolean;
  readonly serviceName: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.serviceName)} 控制台</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #081018;
      --bg-soft: #101b26;
      --panel: rgba(15, 24, 35, 0.94);
      --panel-soft: rgba(24, 37, 52, 0.92);
      --panel-strong: rgba(9, 16, 24, 0.94);
      --line: rgba(154, 167, 184, 0.16);
      --line-strong: rgba(154, 167, 184, 0.26);
      --text: #f4f7fb;
      --muted: #9da9b7;
      --accent: #5cc8ff;
      --accent-soft: rgba(92, 200, 255, 0.12);
      --good: #4ade80;
      --good-soft: rgba(74, 222, 128, 0.12);
      --warn: #fbbf24;
      --warn-soft: rgba(251, 191, 36, 0.12);
      --danger: #fb7185;
      --danger-soft: rgba(251, 113, 133, 0.12);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(92, 200, 255, 0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(74, 222, 128, 0.1), transparent 20%),
        linear-gradient(180deg, #0a121a 0%, #081018 100%);
      color: var(--text);
      font-family: var(--sans);
    }
    .wrap {
      max-width: 1440px;
      margin: 0 auto;
      padding: 28px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: stretch;
      gap: 18px;
      margin-bottom: 18px;
    }
    h1, h2, h3 {
      margin: 0;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    h1 {
      font-size: 34px;
      margin-bottom: 10px;
    }
    h2 {
      font-size: 18px;
      margin-bottom: 6px;
    }
    h3 {
      font-size: 15px;
      margin-bottom: 4px;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 18px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 20px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
      backdrop-filter: blur(12px);
    }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .hero {
      flex: 1 1 auto;
      background: linear-gradient(135deg, rgba(92, 200, 255, 0.14), rgba(74, 222, 128, 0.06));
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 22px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
    }
    .hero-meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .hero-side {
      width: min(360px, 100%);
      display: grid;
      gap: 12px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 18px;
      margin-bottom: 18px;
    }
    .summary-card {
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      min-height: 120px;
    }
    .summary-kicker {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 14px;
    }
    .summary-value {
      font-size: 34px;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 10px;
    }
    .summary-detail {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .badge {
      display: inline-flex;
      border-radius: 999px;
      padding: 6px 11px;
      border: 1px solid var(--line-strong);
      background: rgba(255,255,255,0.04);
      font-size: 12px;
      font-weight: 700;
      gap: 6px;
      align-items: center;
    }
    .badge.good { color: var(--good); background: var(--good-soft); }
    .badge.warn { color: var(--warn); background: var(--warn-soft); }
    .badge.danger { color: var(--danger); background: var(--danger-soft); }
    .mono { font-family: var(--mono); }
    .muted { color: var(--muted); }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .danger { color: var(--danger); }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, #59c7ff, #32b7f5);
      color: #03111b;
      padding: 11px 15px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease;
    }
    button:hover {
      transform: translateY(-1px);
    }
    button:disabled {
      opacity: 0.55;
      cursor: default;
      transform: none;
    }
    button.secondary {
      background: var(--panel-soft);
      color: var(--text);
      border: 1px solid var(--line);
    }
    input[type="password"], input[type="file"], textarea {
      width: 100%;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--panel-strong);
      color: var(--text);
      padding: 10px 12px;
      font: inherit;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
      line-height: 1.5;
      font-family: var(--mono);
      font-size: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 14px;
    }
    .form-grid {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    .checkbox {
      display: flex;
      gap: 8px;
      align-items: center;
      color: var(--text);
    }
    .list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: rgba(255,255,255,0.025);
    }
    .item-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      align-items: center;
    }
    .item-title {
      font-weight: 650;
      word-break: break-word;
    }
    .item-text {
      margin-top: 8px;
      line-height: 1.55;
      word-break: break-word;
    }
    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }
    .inline-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .kv {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 8px 12px;
      margin-top: 14px;
    }
    .kv dt {
      color: var(--muted);
    }
    .kv dd {
      margin: 0;
      word-break: break-word;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
    }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 14px;
      background: #091018;
      overflow: auto;
      border: 1px solid var(--line);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
    }
    .status-line {
      min-height: 22px;
      color: var(--muted);
    }
    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .section-copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .hint {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .empty {
      padding: 18px;
      border-radius: 16px;
      border: 1px dashed var(--line-strong);
      color: var(--muted);
      background: rgba(255,255,255,0.02);
    }
    .log-list {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .log-entry {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: rgba(255,255,255,0.02);
    }
    .log-entry.warn {
      border-color: rgba(251, 191, 36, 0.28);
      background: var(--warn-soft);
    }
    .log-entry.error {
      border-color: rgba(251, 113, 133, 0.34);
      background: var(--danger-soft);
    }
    .tiny {
      font-size: 12px;
      color: var(--muted);
    }
    @media (max-width: 960px) {
      .span-4, .span-5, .span-6, .span-7, .span-8, .span-12 {
        grid-column: span 12;
      }
      .topbar {
        flex-direction: column;
      }
      .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .inline-grid {
        grid-template-columns: 1fr;
      }
      .kv {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 640px) {
      .wrap {
        padding: 18px;
      }
      .summary-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="hero">
        <h1>${escapeHtml(options.serviceName)} 控制台</h1>
        <p>这是给人看的 live 管理页。你可以在这里确认当前服务有没有活着、哪个账号在跑、哪些 thread 卡住了，以及在需要的时候替换容器里的登录态。</p>
        <div class="hero-meta">
          <div class="badge ${options.tokenConfigured ? "good" : "warn"}">${options.tokenConfigured ? "已启用管理员令牌" : "未启用管理员令牌"}</div>
          <div class="badge">每 10 秒自动刷新</div>
          <div class="badge">也可以手动刷新</div>
        </div>
      </div>
      <div class="hero-side">
        <div class="card">
          <div class="section-head">
            <div>
              <h2>访问控制</h2>
              <div class="section-copy">如果配置了管理员令牌，这个页面会用它访问 API。</div>
            </div>
          </div>
          <div class="form-grid">
            <label>
              管理员令牌
              <input id="token-input" type="password" placeholder="${options.tokenConfigured ? "访问 API 时必填" : "当前可留空"}" />
            </label>
            <div class="actions">
              <button id="refresh-button" class="secondary">立即刷新</button>
              <span class="tiny" id="last-refresh">还没有刷新</span>
            </div>
            <div class="status-line" id="token-status"></div>
          </div>
        </div>
      </div>
    </div>

    <section class="summary-grid">
      <div class="summary-card">
        <div class="summary-kicker">服务状态</div>
        <div class="summary-value" id="summary-service">--</div>
        <div class="summary-detail" id="summary-service-detail">正在读取服务信息…</div>
      </div>
      <div class="summary-card">
        <div class="summary-kicker">运行账号</div>
        <div class="summary-value" id="summary-account">--</div>
        <div class="summary-detail" id="summary-account-detail">正在读取账号信息…</div>
      </div>
      <div class="summary-card">
        <div class="summary-kicker">会话概况</div>
        <div class="summary-value" id="summary-sessions">--</div>
        <div class="summary-detail" id="summary-sessions-detail">正在读取会话状态…</div>
      </div>
      <div class="summary-card">
        <div class="summary-kicker">后台任务</div>
        <div class="summary-value" id="summary-jobs">--</div>
        <div class="summary-detail" id="summary-jobs-detail">正在读取后台任务…</div>
      </div>
    </section>

    <div class="grid">
      <section class="card span-4">
        <div class="section-head">
          <div>
            <h2>服务信息</h2>
            <div class="section-copy">这些是当前 broker 容器本身的运行信息。</div>
          </div>
        </div>
        <dl class="kv" id="service-card"></dl>
      </section>

      <section class="card span-4">
        <div class="section-head">
          <div>
            <h2>账号信息</h2>
            <div class="section-copy">这里展示容器里当前 Codex runtime 正在使用的账号。</div>
          </div>
        </div>
        <div id="account-card" class="list"></div>
      </section>

      <section class="card span-4">
        <div class="section-head">
          <div>
            <h2>登录文件</h2>
            <div class="section-copy">确认 auth 和 MCP 凭据有没有就位。</div>
          </div>
        </div>
        <div id="auth-files-card" class="list"></div>
      </section>

      <section class="card span-12">
        <div class="section-head">
          <div>
            <h2>替换登录态</h2>
            <div class="section-copy">把新的 <span class="mono">auth.json</span> 上传到容器里，并可选一起替换 <span class="mono">.credentials.json</span> 和 <span class="mono">config.toml</span>。</div>
          </div>
          <div class="badge warn">会重启内置 Codex runtime</div>
        </div>
        <div class="form-grid">
          <div class="inline-grid">
            <label>
              auth.json 文件
              <input id="auth-json-file" type="file" accept=".json,application/json" />
            </label>
            <label>
              .credentials.json（可选）
              <input id="credentials-json-file" type="file" accept=".json,application/json" />
            </label>
          </div>
          <label>
            或者直接粘贴 auth.json
            <textarea id="auth-json-text" placeholder='把完整 auth.json 直接粘贴到这里。这里有内容时，会优先使用这里，不再读取上面的文件。'></textarea>
          </label>
          <label>
            config.toml（可选）
            <input id="config-toml-file" type="file" accept=".toml,text/plain" />
          </label>
          <label class="checkbox">
            <input id="allow-active" type="checkbox" />
            即使当前有活跃 session，也允许替换并打断它们
          </label>
          <div class="actions">
            <button id="replace-button">替换并重启 runtime</button>
          </div>
          <div class="hint">系统会先把旧文件备份到容器数据目录里的 <span class="mono">admin-backups/auth-switches</span>，然后再写入新文件。</div>
          <div class="status-line" id="replace-status"></div>
        </div>
      </section>

      <section class="card span-8">
        <div class="section-head">
          <div>
            <h2>会话状态</h2>
            <div class="section-copy">优先看这里：哪些 thread 还在跑，哪些消息已经进队列但还没吃掉。</div>
          </div>
        </div>
        <div id="sessions-panel" class="list"></div>
      </section>

      <section class="card span-4">
        <div class="section-head">
          <div>
            <h2>后台任务</h2>
            <div class="section-copy">这些是 broker 托管的 watch / polling 脚本。</div>
          </div>
        </div>
        <div id="jobs-panel" class="list"></div>
      </section>

      <section class="card span-12">
        <div class="section-head">
          <div>
            <h2>最近日志</h2>
            <div class="section-copy">这里只看最近的重要日志，用来快速判断断线、恢复、thread 漂移和 job 失败。</div>
          </div>
        </div>
        <div id="logs-panel" class="log-list"></div>
      </section>
    </div>
  </div>

  <script>
    const tokenKey = "broker-admin-token";
    const tokenConfigured = ${options.tokenConfigured ? "true" : "false"};
    const tokenInput = document.getElementById("token-input");
    const tokenStatus = document.getElementById("token-status");
    const refreshButton = document.getElementById("refresh-button");
    const replaceButton = document.getElementById("replace-button");
    const replaceStatus = document.getElementById("replace-status");
    const lastRefresh = document.getElementById("last-refresh");
    const authJsonText = document.getElementById("auth-json-text");

    tokenInput.value = localStorage.getItem(tokenKey) || "";

    function esc(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function fmtTime(value) {
      if (!value) return "—";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    function fmtDuration(totalSeconds) {
      const seconds = Number(totalSeconds || 0);
      if (!Number.isFinite(seconds) || seconds <= 0) return "刚启动";
      const parts = [];
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainingSeconds = seconds % 60;
      if (hours > 0) parts.push(hours + " 小时");
      if (minutes > 0) parts.push(minutes + " 分钟");
      if (hours === 0 && remainingSeconds > 0) parts.push(remainingSeconds + " 秒");
      return parts.join(" ");
    }

    function statusTone(status) {
      const value = String(status || "").toLowerCase();
      if (["running", "active", "ok", "completed"].includes(value)) return "good";
      if (["pending", "inflight", "starting", "cancelled"].includes(value)) return "warn";
      if (["failed", "error", "stopped"].includes(value)) return "danger";
      return "";
    }

    function renderBadge(label, tone) {
      const cls = tone ? "badge " + tone : "badge";
      return '<span class="' + cls + '">' + esc(label) + "</span>";
    }

    function authHeaders(extra) {
      const headers = Object.assign({}, extra || {});
      const token = tokenInput.value.trim();
      if (token) {
        headers["x-admin-token"] = token;
      }
      return headers;
    }

    function persistToken() {
      localStorage.setItem(tokenKey, tokenInput.value.trim());
      if (tokenConfigured && !tokenInput.value.trim()) {
        tokenStatus.innerHTML = '<span class="warn">这个服务已开启管理员令牌，不填就无法调用 API。</span>';
      } else if (!tokenConfigured) {
        tokenStatus.innerHTML = '<span class="warn">当前没有管理员令牌。只要能访问这个端口的人，都能调用这些管理接口。</span>';
      } else {
        tokenStatus.innerHTML = '<span class="good">令牌已准备好，可以访问管理接口。</span>';
      }
    }

    tokenInput.addEventListener("input", persistToken);
    persistToken();

    function renderSummary(data) {
      const service = data.service || {};
      const state = data.state || {};
      const account = data.account || {};
      const runningJobs = (state.backgroundJobs || []).filter((job) => String(job.status || "").toLowerCase() === "running").length;
      const failedJobs = (state.backgroundJobs || []).filter((job) => String(job.status || "").toLowerCase() === "failed").length;

      document.getElementById("summary-service").textContent = "在线";
      document.getElementById("summary-service-detail").textContent =
        "PID " + (service.pid || "—") + "，已运行 " + fmtDuration(service.uptimeSeconds || 0) + "。";

      const accountLabel = account.ok ? ((account.account && account.account.planType) || "已登录") : "异常";
      document.getElementById("summary-account").textContent = accountLabel;
      document.getElementById("summary-account-detail").textContent = account.ok
        ? (((account.account && account.account.email) || "未提供邮箱") + " · " + ((account.account && account.account.type) || "未知类型"))
        : ("账号读取失败：" + (account.error || "unknown error"));

      document.getElementById("summary-sessions").textContent =
        String(state.activeCount || 0) + " / " + String(state.sessionCount || 0);
      document.getElementById("summary-sessions-detail").textContent =
        "活跃会话 / 总会话。另有 " + String(state.openInboundCount || 0) + " 条待处理消息。";

      document.getElementById("summary-jobs").textContent = String(runningJobs);
      document.getElementById("summary-jobs-detail").textContent =
        "正在运行的后台任务。失败 " + String(failedJobs) + " 个。";
    }

    function renderService(data) {
      const card = document.getElementById("service-card");
      const service = data.service || {};
      card.innerHTML = [
        ["服务名", esc(service.name || "—")],
        ["PID", esc(service.pid || "—")],
        ["运行时长", esc(fmtDuration(service.uptimeSeconds || 0))],
        ["启动时间", esc(fmtTime(service.startedAt))],
        ["端口", esc(service.port || "—")],
        ["会话目录", '<span class="mono">' + esc(service.sessionsRoot || "—") + "</span>"],
        ["仓库目录", '<span class="mono">' + esc(service.reposRoot || "—") + "</span>"],
        ["Codex Home", '<span class="mono">' + esc(service.codexHome || "—") + "</span>"]
      ].map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("");
    }

    function renderAccount(data) {
      const panel = document.getElementById("account-card");
      const account = data.account || {};
      if (!account.ok) {
        panel.innerHTML = '<div class="item danger"><div class="item-title">账号读取失败</div><div class="item-text">' + esc(account.error || "unknown error") + "</div></div>";
        return;
      }

      const summary = account.account || {};
      panel.innerHTML = [
        '<div class="item"><div class="item-head"><div class="item-title">当前运行账号</div>' + renderBadge(summary.planType || "unknown", "good") + '</div><div class="meta"><span>类型：' + esc(summary.type || "—") + '</span><span>邮箱：' + esc(summary.email || "—") + "</span></div></div>",
        account.quota
          ? '<pre>' + esc(JSON.stringify(account.quota, null, 2)) + "</pre>"
          : '<div class="item"><div class="item-title">额度信息</div><div class="item-text muted">' + esc(account.note || "当前接口没有返回 quota 或 usage 字段。") + "</div></div>"
      ].join("");
    }

    function renderAuthFiles(data) {
      const panel = document.getElementById("auth-files-card");
      const entries = [
        ["auth.json", data.authFiles.authJson],
        [".credentials.json", data.authFiles.credentialsJson],
        ["config.toml", data.authFiles.configToml]
      ];
      panel.innerHTML = entries.map(([name, file]) => {
        const meta = file.exists
          ? '<div class="meta"><span>大小：' + esc(file.size) + ' bytes</span><span>更新时间：' + esc(fmtTime(file.mtime)) + "</span></div>"
          : '<div class="meta"><span class="warn">文件不存在</span></div>';
        return '<div class="item"><div class="item-head"><div class="item-title mono">' + esc(name) + '</div>' + renderBadge(file.exists ? "已就位" : "缺失", file.exists ? "good" : "warn") + '</div>' + meta + '<div class="hint mono">' + esc(file.path) + "</div></div>";
      }).join("");
    }

    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const state = data.state || {};
      const active = state.activeSessions || [];
      const inbound = state.openInbound || [];
      const parts = [];
      if (active.length > 0) {
        parts.push(
          active.map((session) =>
            '<div class="item">' +
              '<div class="item-head"><div class="item-title mono">' + esc(session.key || "—") + '</div>' + renderBadge("active", "good") + '</div>' +
              '<div class="meta"><span>最近更新：' + esc(fmtTime(session.updatedAt)) + '</span><span>turn：<span class="mono">' + esc(session.activeTurnId || "—") + '</span></span></div>' +
              '<div class="hint mono">' + esc(session.workspacePath || "—") + "</div>" +
            "</div>"
          ).join("")
        );
      } else {
        parts.push('<div class="empty">当前没有活跃会话。</div>');
      }
      if (inbound.length > 0) {
        parts.push(
          '<div class="section-head" style="margin-top:10px;"><div><h3>待处理消息</h3><div class="section-copy">这些消息已经进了 broker，但还没有完全消化完。</div></div></div>' +
          inbound.map((item) =>
            '<div class="item">' +
              '<div class="item-head"><div class="item-title mono">' + esc(item.sessionKey || "—") + '</div>' + renderBadge(item.status || "unknown", statusTone(item.status)) + '</div>' +
              '<div class="meta"><span>来源：' + esc(item.source || "—") + '</span><span>消息时间：<span class="mono">' + esc(item.messageTs || "—") + "</span></span></div>" +
              '<div class="item-text">' + esc(item.textPreview || "—") + "</div>" +
            "</div>"
          ).join("")
        );
      }
      panel.innerHTML = parts.join("");
    }

    function renderJobs(data) {
      const panel = document.getElementById("jobs-panel");
      const jobs = data.state.backgroundJobs || [];
      if (!jobs.length) {
        panel.innerHTML = '<div class="empty">当前没有后台任务。</div>';
        return;
      }
      panel.innerHTML = jobs.map((job) =>
        '<div class="item"><div class="item-head"><div class="item-title mono">' + esc(job.id || "—") + '</div>' + renderBadge(job.status || "unknown", statusTone(job.status)) + '</div><div class="meta"><span>类型：' + esc(job.kind || "—") + '</span><span>更新时间：' + esc(fmtTime(job.updatedAt)) + '</span></div><div class="hint mono">' + esc(job.cwd || "—") + "</div>" + (job.error ? '<div class="item-text danger">' + esc(job.error) + "</div>" : "") + "</div>"
      ).join("");
    }

    function renderLogs(data) {
      const logs = data.state.recentBrokerLogs || [];
      const panel = document.getElementById("logs-panel");
      if (!logs.length) {
        panel.innerHTML = '<div class="empty">最近没有抓到 broker 日志。</div>';
        return;
      }
      panel.innerHTML = logs.map((entry) => {
        const level = String(entry.level || "info").toLowerCase();
        const tone = level === "warn" ? "warn" : level === "error" ? "error" : "";
        const meta = entry.meta ? '<pre>' + esc(JSON.stringify(entry.meta, null, 2)) + "</pre>" : "";
        return '<div class="log-entry ' + tone + '">' +
          '<div class="item-head"><div class="item-title">' + esc(entry.message || entry.raw || "log") + '</div>' + renderBadge(level, tone) + '</div>' +
          '<div class="meta"><span>' + esc(fmtTime(entry.ts)) + "</span></div>" +
          meta +
        "</div>";
      }).join("");
    }

    function render(data) {
      renderSummary(data);
      renderService(data);
      renderAccount(data);
      renderAuthFiles(data);
      renderSessions(data);
      renderJobs(data);
      renderLogs(data);
    }

    async function readOptionalFile(id) {
      const input = document.getElementById(id);
      const file = input.files && input.files[0];
      if (!file) return undefined;
      return await file.text();
    }

    async function refresh() {
      refreshButton.disabled = true;
      try {
        const response = await fetch("/admin/api/status", {
          headers: authHeaders()
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to fetch status");
        render(payload);
        lastRefresh.textContent = "上次刷新：" + new Date().toLocaleTimeString();
      } catch (error) {
        document.getElementById("logs-panel").innerHTML =
          '<div class="empty danger">读取状态失败：' + esc(error && error.message ? error.message : String(error)) + "</div>";
      } finally {
        refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener("click", refresh);

    replaceButton.addEventListener("click", async () => {
        replaceButton.disabled = true;
      replaceStatus.textContent = "正在写入新文件，并重启容器里的 Codex runtime…";
      try {
        const pastedAuthJson = authJsonText.value.trim();
        const authJsonContent = pastedAuthJson || await readOptionalFile("auth-json-file");
        if (!authJsonContent) {
          throw new Error("必须先选择 auth.json 文件，或者直接粘贴 auth.json 内容");
        }
        const response = await fetch("/admin/api/replace-auth", {
          method: "POST",
          headers: authHeaders({
            "content-type": "application/json"
          }),
          body: JSON.stringify({
            auth_json_content: authJsonContent,
            credentials_json_content: await readOptionalFile("credentials-json-file"),
            config_toml_content: await readOptionalFile("config-toml-file"),
            allow_active: document.getElementById("allow-active").checked
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "登录态替换失败");
        replaceStatus.innerHTML = '<span class="good">登录态已替换完成。</span> 内置 Codex runtime 已重启。';
        render(payload.status);
        lastRefresh.textContent = "上次刷新：" + new Date().toLocaleTimeString();
      } catch (error) {
        replaceStatus.innerHTML = '<span class="danger">' + esc(error && error.message ? error.message : String(error)) + "</span>";
      } finally {
        replaceButton.disabled = false;
      }
    });

    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
