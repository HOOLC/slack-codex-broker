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

    if (!authJsonContent?.trim() && !credentialsJsonContent?.trim() && !configTomlContent?.trim()) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["auth_json_content | credentials_json_content | config_toml_content"]
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
      color-scheme: dark;
      --bg: #ff962d;
      --bg-deep: #d97414;
      --panel: #070707;
      --panel-soft: #0a0a0a;
      --panel-strong: #030303;
      --line: rgba(255, 154, 47, 0.15);
      --line-strong: rgba(255, 154, 47, 0.34);
      --text: #fff1de;
      --muted: #a48f75;
      --accent: #ff9a2f;
      --accent-soft: rgba(255, 154, 47, 0.12);
      --good: #34dd93;
      --good-soft: rgba(52, 221, 147, 0.12);
      --warn: #ffcb63;
      --warn-soft: rgba(255, 203, 99, 0.14);
      --danger: #ff7458;
      --danger-soft: rgba(255, 116, 88, 0.14);
      --mono: "IBM Plex Mono", "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Monaco, Consolas, monospace;
      --sans: "IBM Plex Mono", "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Monaco, Consolas, monospace;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 14% 12%, rgba(255, 198, 122, 0.32), transparent 0 18%),
        radial-gradient(circle at 86% 10%, rgba(255, 206, 139, 0.22), transparent 0 16%),
        linear-gradient(135deg, rgba(255,255,255,0.05) 0 4%, transparent 4% 14%, rgba(255,255,255,0.03) 14% 17%, transparent 17% 31%, rgba(255,255,255,0.04) 31% 35%, transparent 35% 100%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-deep) 100%);
      color: var(--text);
      font-family: var(--sans);
      letter-spacing: 0.01em;
    }
    .wrap {
      max-width: 1720px;
      margin: 0 auto;
      padding: 24px;
    }
    .dashboard {
      border: 1px solid rgba(255, 154, 47, 0.24);
      border-radius: 18px;
      background:
        linear-gradient(180deg, rgba(10, 10, 10, 0.995), rgba(3, 3, 3, 0.995));
      box-shadow:
        0 30px 70px rgba(92, 34, 0, 0.28),
        inset 0 0 0 1px rgba(255,255,255,0.015);
      padding: 16px;
    }
    h1, h2, h3 {
      margin: 0;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    h1 {
      font-size: 22px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    h3 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .card {
      background: rgba(7, 7, 7, 0.96);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.01);
    }
    .headerbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      padding: 14px 16px;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      background:
        linear-gradient(180deg, rgba(255, 154, 47, 0.03), rgba(255, 154, 47, 0.01));
    }
    .header-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .header-subtitle {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
      text-transform: uppercase;
    }
    .header-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .summary-pill {
      display: grid;
      gap: 4px;
      min-height: 82px;
      padding: 10px 12px;
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .summary-pill-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .summary-pill-value {
      color: var(--accent);
      font-size: 22px;
      font-weight: 800;
      line-height: 1.05;
    }
    .summary-pill-detail {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.75fr) minmax(380px, 0.95fr);
      gap: 12px;
      align-items: start;
    }
    .main-stack,
    .side-stack,
    .overview-stack {
      display: grid;
      gap: 12px;
    }
    .toolbar-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .toolbar-grow {
      flex: 1 1 220px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid var(--line-strong);
      background: rgba(255, 154, 47, 0.08);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
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
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 12px;
      background: var(--accent);
      color: #130800;
      padding: 10px 14px;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled {
      opacity: 0.55;
      cursor: default;
      transform: none;
    }
    button.secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--line);
    }
    input[type="password"], input[type="search"], input[type="file"], select, textarea {
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
      line-height: 1.45;
      font-family: var(--mono);
      font-size: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .stack,
    .list,
    .log-list {
      display: grid;
      gap: 10px;
    }
    .item,
    .compact-stat,
    .log-entry,
    .subpanel {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.015);
    }
    .item-head,
    .section-head,
    .subpanel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .section-head {
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .item-title,
    .subpanel-title {
      font-weight: 700;
      word-break: break-word;
    }
    .item-text {
      margin-top: 8px;
      line-height: 1.55;
      word-break: break-word;
    }
    .meta,
    .auth-file-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .compact-kv {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .compact-stat-label {
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .compact-stat-value {
      font-size: 14px;
      font-weight: 700;
      word-break: break-word;
    }
    .status-line {
      min-height: 18px;
      color: var(--muted);
      font-size: 12px;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .empty {
      padding: 12px;
      border: 1px dashed var(--line-strong);
      border-radius: 12px;
      color: var(--muted);
      background: rgba(255,255,255,0.01);
    }
    .log-entry.warn {
      border-color: rgba(255, 203, 99, 0.28);
      background: var(--warn-soft);
    }
    .log-entry.error {
      border-color: rgba(255, 116, 88, 0.36);
      background: var(--danger-soft);
    }
    .tiny {
      font-size: 11px;
      color: var(--muted);
    }
    .session-shell {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255,255,255,0.01);
      overflow: hidden;
    }
    .session-shell[open] {
      border-color: var(--line-strong);
      background: rgba(255, 154, 47, 0.04);
    }
    .session-summary {
      list-style: none;
      cursor: pointer;
      display: grid;
      gap: 6px;
      padding: 10px 12px;
    }
    .session-summary::-webkit-details-marker {
      display: none;
    }
    .session-summary-top {
      display: grid;
      grid-template-columns: minmax(260px, 2.6fr) minmax(160px, 1fr) minmax(180px, 1.1fr) minmax(200px, 1.1fr) minmax(180px, 1fr);
      gap: 6px;
      align-items: start;
    }
    .session-summary-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .session-summary-title {
      font-weight: 650;
      word-break: break-word;
      color: var(--accent);
    }
    .session-summary-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      color: var(--muted);
      font-size: 11px;
    }
    .session-summary-side {
      display: grid;
      gap: 6px;
      align-content: start;
      justify-items: end;
    }
    .session-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .session-body {
      padding: 0 14px 14px;
      display: grid;
      gap: 8px;
    }
    .session-divider {
      height: 1px;
      background: var(--line);
    }
    dialog.admin-modal {
      border: 0;
      padding: 0;
      border-radius: 18px;
      width: min(760px, calc(100vw - 24px));
      background: transparent;
      color: inherit;
    }
    dialog.admin-modal::backdrop {
      background: rgba(3, 10, 18, 0.72);
      backdrop-filter: blur(6px);
    }
    .modal-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
      display: grid;
      gap: 12px;
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .modal-copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }
    .compact-kv {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .compact-stat {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.012);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .compact-stat-label {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .compact-stat-value {
      font-size: 14px;
      font-weight: 650;
      word-break: break-word;
    }
    .session-toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .session-toolbar input {
      min-width: 240px;
      flex: 1 1 280px;
    }
    .session-summary-cell {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .session-summary-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .session-summary-value {
      font-size: 12px;
      line-height: 1.3;
      word-break: break-word;
    }
    .session-summary-value.truncate {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .dense-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0;
      font-size: 12px;
    }
    .dense-table th,
    .dense-table td {
      padding: 6px 5px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .dense-table th {
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .dense-table td code,
    .dense-table td .mono {
      font-size: 11px;
    }
    .session-detail-grid {
      display: grid;
      grid-template-columns: 1.3fr 1fr;
      gap: 12px;
    }
    .subpanel-meta {
      color: var(--muted);
      font-size: 11px;
    }
    .auth-file-list {
      display: grid;
      gap: 8px;
    }
    .auth-file-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.012);
    }
    .auth-file-main {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .auth-file-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .auth-file-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .auth-file-title {
      font-size: 13px;
      font-weight: 700;
    }
    .auth-file-tag {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.02);
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .auth-file-path {
      font-size: 11px;
      line-height: 1.35;
      color: var(--muted);
      word-break: break-word;
    }
    .auth-file-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
    }
    .auth-file-actions button {
      min-width: 88px;
      padding: 8px 12px;
      font-size: 12px;
    }
    @media (max-width: 960px) {
      .headerbar {
        flex-direction: column;
        align-items: stretch;
      }
      .summary-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .layout {
        grid-template-columns: 1fr;
      }
      .compact-kv {
        grid-template-columns: 1fr;
      }
      .session-summary-top {
        grid-template-columns: 1fr;
      }
      .session-detail-grid {
        grid-template-columns: 1fr;
      }
      .auth-file-row {
        grid-template-columns: 1fr;
      }
      .auth-file-actions {
        justify-content: flex-start;
      }
    }
    @media (max-width: 640px) {
      .wrap {
        padding: 12px;
      }
      .summary-strip {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="dashboard">
      <div class="headerbar">
        <div class="header-main">
          <h1>${escapeHtml(options.serviceName)} Admin</h1>
          <div class="header-subtitle">live status, auth, sessions, jobs.</div>
        </div>
        <div class="header-meta">
            <div class="badge ${options.tokenConfigured ? "good" : "warn"}">${options.tokenConfigured ? "已启用管理员令牌" : "未启用管理员令牌"}</div>
            <div class="badge">每 10 秒自动刷新</div>
            <div class="badge">也可以手动刷新</div>
        </div>
      </div>

      <section class="summary-strip">
        <div class="summary-pill">
          <div class="summary-pill-label">服务</div>
          <div class="summary-pill-value" id="summary-service">--</div>
          <div class="summary-pill-detail" id="summary-service-detail">正在读取服务信息…</div>
        </div>
        <div class="summary-pill">
          <div class="summary-pill-label">账号</div>
          <div class="summary-pill-value" id="summary-account">--</div>
          <div class="summary-pill-detail" id="summary-account-detail">正在读取账号信息…</div>
        </div>
        <div class="summary-pill">
          <div class="summary-pill-label">会话</div>
          <div class="summary-pill-value" id="summary-sessions">--</div>
          <div class="summary-pill-detail" id="summary-sessions-detail">正在读取会话状态…</div>
        </div>
        <div class="summary-pill">
          <div class="summary-pill-label">任务</div>
          <div class="summary-pill-value" id="summary-jobs">--</div>
          <div class="summary-pill-detail" id="summary-jobs-detail">正在读取后台任务…</div>
        </div>
      </section>

      <div class="layout">
        <div class="main-stack">
          <section class="card">
            <div class="section-head">
              <h2>会话状态</h2>
              <div class="session-toolbar">
                <input id="session-search" type="search" placeholder="搜索 session key / channel / workspace / snippet" />
                <select id="session-filter">
                  <option value="all">全部</option>
                  <option value="active">只看 active</option>
                  <option value="inbound">只看有待处理消息</option>
                  <option value="jobs">只看有运行中任务</option>
                  <option value="issues">只看有失败任务</option>
                </select>
              </div>
            </div>
            <div id="sessions-panel" class="list"></div>
          </section>

          <section class="card">
            <div class="section-head">
              <h2>最近日志</h2>
              <div class="tiny mono">broker / recovery / turn</div>
            </div>
            <div id="logs-panel" class="log-list"></div>
          </section>
        </div>

        <aside class="side-stack">
          <section class="card">
            <div class="section-head">
              <h2>运行概览</h2>
              <div class="toolbar-strip">
                <input
                  id="token-input"
                  class="toolbar-grow"
                  type="password"
                  placeholder="${options.tokenConfigured ? "管理员令牌" : "当前可留空"}"
                />
                <button id="refresh-button" class="secondary">刷新</button>
              </div>
            </div>
            <div class="status-line" id="token-status"></div>
            <div class="tiny" id="last-refresh">还没有刷新</div>
          </section>

          <div class="overview-stack">
            <section class="subpanel">
              <div class="subpanel-head">
                <div class="subpanel-title">服务</div>
                <div class="tiny mono">runtime</div>
              </div>
              <div id="service-card"></div>
            </section>

            <section class="subpanel">
              <div class="subpanel-head">
                <div class="subpanel-title">账号</div>
                <div class="tiny mono">account</div>
              </div>
              <div id="account-card"></div>
            </section>

            <section class="subpanel">
              <div class="subpanel-head">
                <div class="subpanel-title">登录文件</div>
                <div class="tiny mono">auth / mcp / config</div>
              </div>
              <div class="auth-file-list">
                <div class="auth-file-row">
                  <div class="auth-file-main">
                    <div class="auth-file-head">
                      <div class="auth-file-title-group">
                        <div class="auth-file-title mono">auth.json</div>
                        <div class="auth-file-tag">常用</div>
                      </div>
                      <div id="auth-file-auth-badge"></div>
                    </div>
                    <div class="auth-file-meta" id="auth-file-auth-meta"></div>
                    <div class="auth-file-path mono" id="auth-file-auth-path"></div>
                  </div>
                  <div class="auth-file-actions">
                    <button id="open-auth-dialog">替换</button>
                  </div>
                </div>

                <div class="auth-file-row">
                  <div class="auth-file-main">
                    <div class="auth-file-head">
                      <div class="auth-file-title-group">
                        <div class="auth-file-title mono">.credentials.json</div>
                        <div class="auth-file-tag">MCP</div>
                      </div>
                      <div id="auth-file-credentials-badge"></div>
                    </div>
                    <div class="auth-file-meta" id="auth-file-credentials-meta"></div>
                    <div class="auth-file-path mono" id="auth-file-credentials-path"></div>
                  </div>
                  <div class="auth-file-actions">
                    <button id="open-credentials-dialog" class="secondary">替换</button>
                  </div>
                </div>

                <div class="auth-file-row">
                  <div class="auth-file-main">
                    <div class="auth-file-head">
                      <div class="auth-file-title-group">
                        <div class="auth-file-title mono">config.toml</div>
                        <div class="auth-file-tag">配置</div>
                      </div>
                      <div id="auth-file-config-badge"></div>
                    </div>
                    <div class="auth-file-meta" id="auth-file-config-meta"></div>
                    <div class="auth-file-path mono" id="auth-file-config-path"></div>
                  </div>
                  <div class="auth-file-actions">
                    <button id="open-config-dialog" class="secondary">替换</button>
                  </div>
                </div>
              </div>
              <div class="status-line" id="replace-status"></div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  </div>

  <dialog id="auth-dialog" class="admin-modal">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>替换 auth.json</h2>
          <div class="modal-copy">只改运行账号。你可以上传文件，或者直接粘贴完整的 <span class="mono">auth.json</span>。如果两者都提供，优先使用粘贴内容。</div>
        </div>
        <button id="close-auth-dialog" class="secondary" type="button">关闭</button>
      </div>
      <div class="stack">
        <label>
          auth.json 文件
          <input id="auth-json-file" type="file" accept=".json,application/json" />
        </label>
        <label>
          或者直接粘贴 auth.json
          <textarea id="auth-json-text" placeholder='把完整 auth.json 粘贴到这里。'></textarea>
        </label>
        <label class="checkbox">
          <input id="allow-active-auth" type="checkbox" />
          即使当前有活跃 session，也允许替换并打断它们
        </label>
      </div>
      <div class="modal-actions">
        <button id="submit-auth-dialog">应用 auth.json</button>
      </div>
      <div class="status-line" id="auth-dialog-status"></div>
    </div>
  </dialog>

  <dialog id="credentials-dialog" class="admin-modal">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>替换 .credentials.json</h2>
          <div class="modal-copy">只改 MCP OAuth 凭据。支持上传文件，也支持直接粘贴完整 JSON。</div>
        </div>
        <button id="close-credentials-dialog" class="secondary" type="button">关闭</button>
      </div>
      <div class="stack">
        <label>
          .credentials.json 文件
          <input id="credentials-json-file" type="file" accept=".json,application/json" />
        </label>
        <label>
          或者直接粘贴 .credentials.json
          <textarea id="credentials-json-text" placeholder='把完整 .credentials.json 粘贴到这里。'></textarea>
        </label>
        <label class="checkbox">
          <input id="allow-active-credentials" type="checkbox" />
          即使当前有活跃 session，也允许替换并打断它们
        </label>
      </div>
      <div class="modal-actions">
        <button id="submit-credentials-dialog">应用 .credentials.json</button>
      </div>
      <div class="status-line" id="credentials-dialog-status"></div>
    </div>
  </dialog>

  <dialog id="config-dialog" class="admin-modal">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>替换 config.toml</h2>
          <div class="modal-copy">只改运行配置。支持上传文件，也支持直接粘贴完整文本。</div>
        </div>
        <button id="close-config-dialog" class="secondary" type="button">关闭</button>
      </div>
      <div class="stack">
        <label>
          config.toml 文件
          <input id="config-toml-file" type="file" accept=".toml,text/plain" />
        </label>
        <label>
          或者直接粘贴 config.toml
          <textarea id="config-toml-text" placeholder='把完整 config.toml 粘贴到这里。'></textarea>
        </label>
        <label class="checkbox">
          <input id="allow-active-config" type="checkbox" />
          即使当前有活跃 session，也允许替换并打断它们
        </label>
      </div>
      <div class="modal-actions">
        <button id="submit-config-dialog">应用 config.toml</button>
      </div>
      <div class="status-line" id="config-dialog-status"></div>
    </div>
  </dialog>

  <script>
    const tokenKey = "broker-admin-token";
    const tokenConfigured = ${options.tokenConfigured ? "true" : "false"};
    const tokenInput = document.getElementById("token-input");
    const tokenStatus = document.getElementById("token-status");
    const refreshButton = document.getElementById("refresh-button");
    const replaceStatus = document.getElementById("replace-status");
    const lastRefresh = document.getElementById("last-refresh");
    const sessionSearch = document.getElementById("session-search");
    const sessionFilter = document.getElementById("session-filter");
    const authJsonText = document.getElementById("auth-json-text");
    const credentialsJsonText = document.getElementById("credentials-json-text");
    const configTomlText = document.getElementById("config-toml-text");
    let latestStatus = null;
    const dialogs = [
      ["auth-dialog", "open-auth-dialog", "close-auth-dialog"],
      ["credentials-dialog", "open-credentials-dialog", "close-credentials-dialog"],
      ["config-dialog", "open-config-dialog", "close-config-dialog"]
    ];

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

    function clampPercent(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return 0;
      return Math.max(0, Math.min(100, Math.round(number)));
    }

    function formatWindowLabel(windowDurationMins) {
      const mins = Number(windowDurationMins);
      if (!Number.isFinite(mins) || mins <= 0) {
        return "window unknown";
      }
      if (mins === 300) {
        return "5h";
      }
      if (mins === 10080) {
        return "weekly";
      }
      if (mins % 1440 === 0) {
        return String(mins / 1440) + "d";
      }
      if (mins % 60 === 0) {
        return String(mins / 60) + "h";
      }
      return String(mins) + "m";
    }

    function formatRelativeDuration(ms) {
      const absMs = Math.abs(ms);
      const totalMinutes = Math.round(absMs / 60000);
      if (totalMinutes < 1) {
        return "under 1m";
      }
      if (totalMinutes < 60) {
        return totalMinutes + "m";
      }
      const totalHours = Math.round(absMs / 3600000);
      if (totalHours < 48) {
        return totalHours + "h";
      }
      const totalDays = Math.round(absMs / 86400000);
      return totalDays + "d";
    }

    function formatResetTime(resetsAtSeconds) {
      if (resetsAtSeconds == null) {
        return "reset unknown";
      }

      const resetMs = Number(resetsAtSeconds) * 1000;
      if (!Number.isFinite(resetMs)) {
        return "reset " + String(resetsAtSeconds);
      }

      const delta = resetMs - Date.now();
      if (Math.abs(delta) < 30000) {
        return "just reset";
      }

      const relative = formatRelativeDuration(delta);
      const exact = fmtTime(resetMs);
      return delta > 0 ? ("resets in " + relative + " · " + exact) : ("reset " + relative + " ago · " + exact);
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
        tokenStatus.innerHTML = '<span class="warn">缺少管理员令牌</span>';
      } else if (!tokenConfigured) {
        tokenStatus.innerHTML = '<span class="warn">管理员接口未设防</span>';
      } else {
        tokenStatus.innerHTML = '<span class="good">管理员令牌已就绪</span>';
      }
    }

    tokenInput.addEventListener("input", persistToken);
    persistToken();

    function renderSummary(data) {
      const service = data.service || {};
      const state = data.state || {};
      const account = data.account || {};
      const rateLimits = data.rateLimits || {};
      const runningJobs = Number(state.runningBackgroundJobCount || 0);
      const failedJobs = Number(state.failedBackgroundJobCount || 0);

      document.getElementById("summary-service").textContent = "在线";
      document.getElementById("summary-service-detail").textContent =
        "PID " + (service.pid || "—") + "，已运行 " + fmtDuration(service.uptimeSeconds || 0) + "。";

      const accountLabel = account.ok ? ((account.account && account.account.planType) || "已登录") : "异常";
      document.getElementById("summary-account").textContent = accountLabel;
      document.getElementById("summary-account-detail").textContent = account.ok
        ? (
            ((account.account && account.account.email) || "未提供邮箱") +
            " · " +
            ((account.account && account.account.type) || "未知类型") +
            " · " +
            summarizeRateLimits(rateLimits)
          )
        : ("账号读取失败：" + (account.error || "unknown error"));

      document.getElementById("summary-sessions").textContent =
        String(state.activeCount || 0) + " / " + String(state.sessionCount || 0);
      document.getElementById("summary-sessions-detail").textContent =
        "活跃 / 总会话，待处理 " + String(state.openInboundCount || 0) + "。";

      document.getElementById("summary-jobs").textContent = String(runningJobs);
      document.getElementById("summary-jobs-detail").textContent =
        "运行中任务，失败 " + String(failedJobs) + "。";
    }

    function renderService(data) {
      const card = document.getElementById("service-card");
      const service = data.service || {};
      card.innerHTML =
        '<div class="compact-kv">' +
          [
            ["服务名", esc(service.name || "—")],
            ["PID", esc(service.pid || "—")],
            ["运行时长", esc(fmtDuration(service.uptimeSeconds || 0))],
            ["端口", esc(service.port || "—")],
            ["启动时间", esc(fmtTime(service.startedAt))],
            ["管理员令牌", service.adminTokenConfigured ? "已配置" : "未配置"]
          ].map(([k, v]) =>
            '<div class="compact-stat"><div class="compact-stat-label">' + k + '</div><div class="compact-stat-value">' + v + "</div></div>"
          ).join("") +
        '</div>' +
        '<div class="list">' +
          [
            ["会话目录", service.sessionsRoot || "—"],
            ["仓库目录", service.reposRoot || "—"],
            ["Codex Home", service.codexHome || "—"]
          ].map(([k, v]) =>
            '<div class="item"><div class="item-head"><div class="item-title">' + esc(k) + '</div></div><div class="hint mono">' + esc(v) + "</div></div>"
          ).join("") +
        '</div>';
    }

    function formatRateLimitWindow(window) {
      if (!window) {
        return "—";
      }

      const parts = [formatWindowLabel(window.windowDurationMins)];
      const remaining = formatRemainingPercent(window);
      if (remaining !== "—") {
        parts.push(remaining);
      }
      parts.push(formatResetTime(window.resetsAt));
      return parts.join(" · ");
    }

    function formatRemainingPercent(window) {
      if (!window) {
        return "—";
      }

      const usedPercent = clampPercent(window.usedPercent);
      const remainingPercent = Math.max(0, 100 - usedPercent);
      return String(remainingPercent) + "% left";
    }

    function formatCreditsSnapshot(credits) {
      if (!credits) {
        return "—";
      }

      const parts = [credits.unlimited ? "unlimited" : credits.hasCredits ? "has credits" : "no credits"];
      if (credits.balance != null) {
        parts.push("balance " + credits.balance);
      }
      return parts.join(" · ");
    }

    function summarizeRateLimits(rateLimits) {
      if (!rateLimits || !rateLimits.ok) {
        return rateLimits && rateLimits.error ? "额度读取失败：" + rateLimits.error : "额度不可用";
      }

      const snapshot = rateLimits.rateLimits || {};
      const parts = [];
      if (snapshot.planType) {
        parts.push(String(snapshot.planType));
      }
      if (snapshot.limitName || snapshot.limitId) {
        parts.push([snapshot.limitName, snapshot.limitId].filter(Boolean).join(" / "));
      }
      const primary = formatRateLimitWindow(snapshot.primary);
      if (primary !== "—") {
        parts.push("主 " + primary);
      }
      const credits = formatCreditsSnapshot(snapshot.credits);
      if (credits !== "—") {
        parts.push("credits " + credits);
      }
      return parts.length > 0 ? parts.join(" · ") : "额度已读取";
    }

    function renderRateLimitBucket(snapshot, key) {
      const label = [snapshot.limitName, snapshot.limitId || key].filter(Boolean).join(" / ") || key;
      const primary = formatRateLimitWindow(snapshot.primary);
      const secondary = formatRateLimitWindow(snapshot.secondary);
      const credits = formatCreditsSnapshot(snapshot.credits);
      return [
        '<div class="item">',
          '<div class="item-head">',
            '<div class="item-title mono">' + esc(label) + '</div>',
            renderBadge(snapshot.planType || "unknown", "good") +
          '</div>',
          '<div class="meta">' +
            '<span>主：' + esc(primary) + '</span>' +
            '<span>副：' + esc(secondary) + '</span>' +
            '<span>credits：' + esc(credits) + '</span>' +
          '</div>',
        '</div>'
      ].join("");
    }

    function renderAccount(data) {
      const panel = document.getElementById("account-card");
      const account = data.account || {};
      if (!account.ok) {
        panel.innerHTML = '<div class="item danger"><div class="item-title">账号读取失败</div><div class="item-text">' + esc(account.error || "unknown error") + "</div></div>";
        return;
      }

      const summary = account.account || {};
      const rateLimits = data.rateLimits || {};
      const rateLimitSnapshot = rateLimits.ok ? (rateLimits.rateLimits || null) : null;
      const rateLimitBuckets = rateLimits.ok && rateLimits.rateLimitsByLimitId ? Object.entries(rateLimits.rateLimitsByLimitId) : [];
      const extraRateLimitBuckets = rateLimitBuckets.filter(([key]) => !rateLimitSnapshot || key !== rateLimitSnapshot.limitId);
      panel.innerHTML = [
        '<div class="compact-kv">' +
          [
            ["套餐", summary.planType || "unknown"],
            ["类型", summary.type || "—"],
            ["邮箱", summary.email || "—"],
            ["额度", rateLimits.ok ? "已提供" : "未提供"]
          ].map(([k, v]) =>
            '<div class="compact-stat"><div class="compact-stat-label">' + esc(k) + '</div><div class="compact-stat-value">' + esc(v) + "</div></div>"
          ).join("") +
        '</div>',
        '<div class="item">' +
          '<div class="item-head">' +
            '<div class="item-title">额度 / credits</div>' +
            '<div class="tiny mono">account/rateLimits/read</div>' +
          '</div>' +
          (rateLimits.ok && rateLimitSnapshot
            ? [
                '<div class="compact-kv">' +
                  [
                    ["主额度", [rateLimitSnapshot.limitName, rateLimitSnapshot.limitId].filter(Boolean).join(" / ") || "—"],
                    ["计划", rateLimitSnapshot.planType || "—"],
                    ["主窗口", rateLimitSnapshot.primary ? formatWindowLabel(rateLimitSnapshot.primary.windowDurationMins) : "—"],
                    ["主剩余", formatRemainingPercent(rateLimitSnapshot.primary)],
                    ["主重置", rateLimitSnapshot.primary ? formatResetTime(rateLimitSnapshot.primary.resetsAt) : "—"],
                    ["副窗口", rateLimitSnapshot.secondary ? formatWindowLabel(rateLimitSnapshot.secondary.windowDurationMins) : "—"],
                    ["副剩余", formatRemainingPercent(rateLimitSnapshot.secondary)],
                    ["副重置", rateLimitSnapshot.secondary ? formatResetTime(rateLimitSnapshot.secondary.resetsAt) : "—"],
                    ["credits", formatCreditsSnapshot(rateLimitSnapshot.credits)],
                    ["限额桶", String(rateLimitBuckets.length || 1)]
                  ].map(([k, v]) =>
                    '<div class="compact-stat"><div class="compact-stat-label">' + esc(k) + '</div><div class="compact-stat-value">' + esc(v) + "</div></div>"
                  ).join("") +
                '</div>' +
                (extraRateLimitBuckets.length
                  ? '<div class="list">' + extraRateLimitBuckets.map(([key, snapshot]) => renderRateLimitBucket(snapshot, key)).join("") + '</div>'
                  : "")
              ].join("")
            : '<div class="item-text muted">' + esc(rateLimits.error || "当前接口没有返回 rateLimits。") + "</div>"
          ) +
        '</div>'
      ].join("");
    }

    function renderAuthFiles(data) {
      const entries = [
        ["auth", data.authFiles.authJson],
        ["credentials", data.authFiles.credentialsJson],
        ["config", data.authFiles.configToml]
      ];
      entries.forEach(([key, file]) => {
        const badgeNode = document.getElementById("auth-file-" + key + "-badge");
        const metaNode = document.getElementById("auth-file-" + key + "-meta");
        const pathNode = document.getElementById("auth-file-" + key + "-path");
        badgeNode.innerHTML = renderBadge(file.exists ? "已就位" : "缺失", file.exists ? "good" : "warn");
        metaNode.innerHTML = file.exists
          ? '<span>大小：' + esc(file.size) + ' bytes</span><span>更新时间：' + esc(fmtTime(file.mtime)) + "</span>"
          : '<span class="warn">文件不存在</span>';
        pathNode.textContent = file.path || "—";
      });
    }

    function summarizeSessionLead(session) {
      const inbound = session.openInbound || [];
      if (inbound.length > 0) {
        return inbound.map((item) => item.textPreview).filter(Boolean)[0] || "有待处理消息";
      }
      const jobs = session.backgroundJobs || [];
      if (jobs.length > 0) {
        const running = jobs.find((job) => job.status === "running") || jobs[0];
        return (running.kind || "job") + " · " + (running.status || "unknown");
      }
      return "当前无待处理项";
    }

    function renderDenseInboundTable(inbound) {
      if (!inbound.length) {
        return '<div class="empty">没有待处理消息。</div>';
      }
      return '<table class="dense-table"><thead><tr><th>状态</th><th>来源</th><th>消息</th><th>更新时间</th></tr></thead><tbody>' +
        inbound.map((item) =>
          '<tr>' +
            '<td>' + renderBadge(item.status || "unknown", statusTone(item.status)) + '</td>' +
            '<td><span class="mono">' + esc(item.source || "—") + '</span></td>' +
            '<td>' +
              '<div class="mono tiny">' + esc(item.messageTs || "—") + '</div>' +
              '<div>' + esc(item.textPreview || "—") + '</div>' +
            '</td>' +
            '<td>' + esc(fmtTime(item.updatedAt)) + '</td>' +
          '</tr>'
        ).join("") +
      "</tbody></table>";
    }

    function renderDenseJobsTable(jobs, totals) {
      if (!jobs.length) {
        return '<div class="empty">没有关联后台任务。</div>';
      }
      return '<table class="dense-table"><thead><tr><th>状态</th><th>类型</th><th>CWD</th><th>更新时间</th></tr></thead><tbody>' +
        jobs.map((job) =>
          '<tr>' +
            '<td>' + renderBadge(job.status || "unknown", statusTone(job.status)) + '</td>' +
            '<td><span class="mono">' + esc(job.kind || "—") + '</span></td>' +
            '<td>' +
              '<div class="mono">' + esc(job.cwd || "—") + '</div>' +
              (job.error ? '<div class="danger tiny" style="margin-top:4px;">' + esc(job.error) + '</div>' : "") +
            '</td>' +
            '<td>' + esc(fmtTime(job.updatedAt)) + '</td>' +
          '</tr>'
        ).join("") +
      "</tbody></table>" +
      (totals.total > jobs.length ? '<div class="hint">这里只显示最近 ' + esc(jobs.length) + ' 条，历史总数 ' + esc(totals.total) + '。</div>' : "");
    }

    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const state = data.state || {};
      const allSessions = state.sessions || [];
      const needle = (sessionSearch.value || "").trim().toLowerCase();
      const mode = sessionFilter.value || "all";
      const sessions = allSessions.filter((session) => {
        const runningJobs = Number(session.runningBackgroundJobCount || 0);
        const failedJobs = Number(session.failedBackgroundJobCount || 0);
        const inboundCount = Number(session.openInboundCount || 0);
        if (mode === "active" && !session.activeTurnId) return false;
        if (mode === "inbound" && inboundCount === 0) return false;
        if (mode === "jobs" && runningJobs === 0) return false;
        if (mode === "issues" && failedJobs === 0) return false;
        if (!needle) return true;
        const haystack = [
          session.key,
          session.channelId,
          session.rootThreadTs,
          session.workspacePath,
          summarizeSessionLead(session),
          ...(session.openInbound || []).map((item) => item.textPreview || ""),
          ...(session.backgroundJobs || []).map((job) => [job.kind, job.cwd, job.error].filter(Boolean).join(" "))
        ].join("\\n").toLowerCase();
        return haystack.includes(needle);
      });
      const parts = [];
      if (sessions.length > 0) {
        parts.push(
          sessions.map((session) => {
            const jobs = session.backgroundJobs || [];
            const inbound = session.openInbound || [];
            const isActive = Boolean(session.activeTurnId);
            const runningJobs = Number(session.runningBackgroundJobCount || 0);
            const totalJobs = Number(session.backgroundJobCount || 0);
            const failedJobs = Number(session.failedBackgroundJobCount || 0);
            const turnBadge = isActive ? renderBadge("active", "good") : renderBadge("idle", "warn");
            const lead = summarizeSessionLead(session);
            return (
            '<details class="session-shell">' +
              '<summary class="session-summary">' +
                '<div class="session-summary-top">' +
                  '<div class="session-summary-main">' +
                    '<div class="session-summary-title mono">' + esc(session.key || "—") + '</div>' +
                    '<div class="session-summary-meta"><span>channel ' + esc(session.channelId || "—") + '</span><span>thread ' + esc(session.rootThreadTs || "—") + '</span></div>' +
                  '</div>' +
                  '<div class="session-summary-cell">' +
                    '<div class="session-summary-label">最近状态</div>' +
                    '<div class="session-summary-value">更新 ' + esc(fmtTime(session.updatedAt)) + '</div>' +
                    '<div class="session-summary-value">回复 ' + esc(fmtTime(session.lastSlackReplyAt)) + '</div>' +
                  '</div>' +
                  '<div class="session-summary-cell">' +
                    '<div class="session-summary-label">资源</div>' +
                    '<div class="session-summary-value">待处理 ' + esc(session.openInboundCount || 0) + ' · 运行中任务 ' + esc(runningJobs) + ' · 总任务 ' + esc(totalJobs) + '</div>' +
                    '<div class="session-summary-value">失败任务 ' + esc(failedJobs) + '</div>' +
                  '</div>' +
                  '<div class="session-summary-cell">' +
                    '<div class="session-summary-label">当前线索</div>' +
                    '<div class="session-summary-value truncate">' + esc(lead) + '</div>' +
                  '</div>' +
                  '<div class="session-summary-side">' +
                    turnBadge +
                    '<div class="tiny mono">' + esc(session.workspacePath || "—") + '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="session-counts">' +
                  renderBadge("待处理 " + esc(session.openInboundCount || 0), Number(session.openInboundCount || 0) > 0 ? "warn" : "") +
                  renderBadge("运行中任务 " + esc(runningJobs), runningJobs > 0 ? "good" : "") +
                  renderBadge("总任务 " + esc(totalJobs), totalJobs > 0 ? "warn" : "") +
                  (failedJobs > 0 ? renderBadge("失败 " + esc(failedJobs), "danger") : "") +
                  (session.activeTurnId ? renderBadge("turn 已占用", "good") : renderBadge("当前空闲", "warn")) +
                '</div>' +
              '</summary>' +
              '<div class="session-body">' +
                '<div class="session-divider"></div>' +
                '<div class="meta"><span>工作目录：<span class="mono">' + esc(session.workspacePath || "—") + '</span></span>' +
                (session.activeTurnId ? '<span>turn：<span class="mono">' + esc(session.activeTurnId) + '</span></span>' : "") +
                '</div>' +
                '<div class="session-detail-grid">' +
                  '<div class="subpanel">' +
                    '<div class="subpanel-head"><div class="subpanel-title">待处理消息</div><div class="subpanel-meta">当前 ' + esc(inbound.length) + ' 条</div></div>' +
                    renderDenseInboundTable(inbound) +
                  '</div>' +
                  '<div class="subpanel">' +
                    '<div class="subpanel-head"><div class="subpanel-title">后台任务</div><div class="subpanel-meta">运行中 ' + esc(runningJobs) + ' / 总计 ' + esc(totalJobs) + (failedJobs > 0 ? ' / 失败 ' + esc(failedJobs) : '') + '</div></div>' +
                    renderDenseJobsTable(jobs, { total: totalJobs }) +
                  '</div>' +
                '</div>' +
              '</div>' +
            "</details>"
            );
          }).join("")
        );
      } else {
        parts.push('<div class="empty">当前筛选条件下没有 session。</div>');
      }
      panel.innerHTML = parts.join("");
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
        const meta = entry.meta ? '<details><summary class="tiny">展开 meta</summary><pre>' + esc(JSON.stringify(entry.meta, null, 2)) + "</pre></details>" : "";
        return '<div class="log-entry ' + tone + '">' +
          '<div class="item-head"><div class="item-title">' + esc(entry.message || entry.raw || "log") + '</div>' + renderBadge(level, tone) + '</div>' +
          '<div class="meta"><span>' + esc(fmtTime(entry.ts)) + "</span></div>" +
          meta +
        "</div>";
      }).join("");
    }

    function render(data) {
      latestStatus = data;
      renderSummary(data);
      renderService(data);
      renderAccount(data);
      renderAuthFiles(data);
      renderSessions(data);
      renderLogs(data);
    }

    async function readOptionalFile(id) {
      const input = document.getElementById(id);
      const file = input.files && input.files[0];
      if (!file) return undefined;
      return await file.text();
    }

    function bindDialog(dialogId, openId, closeId) {
      const dialog = document.getElementById(dialogId);
      document.getElementById(openId).addEventListener("click", () => {
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        }
      });
      document.getElementById(closeId).addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        const rect = dialog.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        if (!inside) {
          dialog.close();
        }
      });
    }

    async function replaceSingleFile(options) {
      const button = document.getElementById(options.buttonId);
      const statusNode = document.getElementById(options.statusId);
      const dialog = document.getElementById(options.dialogId);
      button.disabled = true;
      statusNode.textContent = "正在写入新文件，并重启容器里的 Codex runtime…";
      replaceStatus.textContent = "";
      try {
        const pastedValue = options.textareaId ? document.getElementById(options.textareaId).value.trim() : "";
        const fileValue = options.fileInputId ? await readOptionalFile(options.fileInputId) : undefined;
        const content = pastedValue || fileValue;
        if (!content) {
          throw new Error("请先提供要替换的文件内容。");
        }
        const payload = {
          auth_json_content: undefined,
          credentials_json_content: undefined,
          config_toml_content: undefined,
          allow_active: document.getElementById(options.allowActiveId).checked
        };
        payload[options.payloadKey] = content;
        const response = await fetch("/admin/api/replace-auth", {
          method: "POST",
          headers: authHeaders({
            "content-type": "application/json"
          }),
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "替换失败");
        }
        statusNode.innerHTML = '<span class="good">' + esc(options.successMessage) + "</span>";
        replaceStatus.innerHTML = '<span class="good">' + esc(options.successMessage) + "</span>";
        render(result.status);
        lastRefresh.textContent = "上次刷新：" + new Date().toLocaleTimeString();
        if (typeof dialog.close === "function") {
          dialog.close();
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        statusNode.innerHTML = '<span class="danger">' + esc(message) + "</span>";
        replaceStatus.innerHTML = '<span class="danger">' + esc(message) + "</span>";
      } finally {
        button.disabled = false;
      }
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
    sessionSearch.addEventListener("input", () => {
      if (latestStatus) renderSessions(latestStatus);
    });
    sessionFilter.addEventListener("change", () => {
      if (latestStatus) renderSessions(latestStatus);
    });
    dialogs.forEach(([dialogId, openId, closeId]) => bindDialog(dialogId, openId, closeId));

    document.getElementById("submit-auth-dialog").addEventListener("click", () =>
      replaceSingleFile({
        dialogId: "auth-dialog",
        buttonId: "submit-auth-dialog",
        statusId: "auth-dialog-status",
        textareaId: "auth-json-text",
        fileInputId: "auth-json-file",
        allowActiveId: "allow-active-auth",
        payloadKey: "auth_json_content",
        successMessage: "auth.json 已替换完成，内置 Codex runtime 已重启。"
      })
    );

    document.getElementById("submit-credentials-dialog").addEventListener("click", () =>
      replaceSingleFile({
        dialogId: "credentials-dialog",
        buttonId: "submit-credentials-dialog",
        statusId: "credentials-dialog-status",
        textareaId: "credentials-json-text",
        fileInputId: "credentials-json-file",
        allowActiveId: "allow-active-credentials",
        payloadKey: "credentials_json_content",
        successMessage: ".credentials.json 已替换完成，内置 Codex runtime 已重启。"
      })
    );

    document.getElementById("submit-config-dialog").addEventListener("click", () =>
      replaceSingleFile({
        dialogId: "config-dialog",
        buttonId: "submit-config-dialog",
        statusId: "config-dialog-status",
        textareaId: "config-toml-text",
        fileInputId: "config-toml-file",
        allowActiveId: "allow-active-config",
        payloadKey: "config_toml_content",
        successMessage: "config.toml 已替换完成，内置 Codex runtime 已重启。"
      })
    );

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
