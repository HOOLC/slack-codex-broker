import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url);
const adminUiRoot = new URL("../src/admin-ui/", import.meta.url);

describe("admin React UI architecture", () => {
  it("documents the full React ownership target and acceptance criteria", async () => {
    const doc = await fs.readFile(new URL("../docs/admin-react-ui.md", import.meta.url), "utf8");
    expect(doc).toContain("Make the admin frontend a single React application.");
    expect(doc).toContain("No business UI may use `getElementById`, `querySelector`, or `innerHTML`");
    expect(doc).toContain("GitHub account work continues in React");
    expect(doc).toContain("`pnpm test` and `pnpm build` pass");
  });

  it("does not ship or import the legacy imperative admin client", async () => {
    await expect(fs.access(new URL("../src/admin-ui/admin-legacy.js", import.meta.url))).rejects.toThrow();

    const main = await fs.readFile(new URL("../src/admin-ui/main.tsx", import.meta.url), "utf8");
    expect(main).not.toContain("admin-legacy");
    expect(main).not.toContain("initAdminPage");
    expect(main).not.toContain("dangerouslySetInnerHTML");
    expect(main).not.toContain("renderAdminShellHtml");
    expect(main).not.toContain("session-react-root");
  });

  it("renders the shell as React components instead of an injected HTML string", async () => {
    const shell = await readAdminShellSource();
    expect(shell).toContain("export function AdminShell");
    expect(shell).not.toContain("renderAdminShellHtml");
    expect(shell).not.toContain("return `");
    expect(shell).not.toContain("dangerouslySetInnerHTML");
  });

  it("bootstraps from lightweight control-plane APIs instead of the monolithic status endpoint", async () => {
    const shell = await readAdminShellSource();
    expect(shell).toContain("const nextStatus = await loadAdminSessionsStatus()");
    expect(shell).toContain("void loadAdminOverview()");
    expect(shell.indexOf("const nextStatus = await loadAdminSessionsStatus()")).toBeLessThan(
      shell.indexOf("void loadAdminOverview()")
    );
    expect(shell).toContain('requestJson("/admin/api/sessions", { timeoutMs: 45_000 })');
    expect(shell).toContain('requestJson("/admin/api/overview", { timeoutMs: 45_000 })');
    expect(shell).toContain('requestJson("/admin/api/logs?limit=40", { timeoutMs: 5_000 })');
    expect(shell).not.toContain('requestJson("/admin/api/status")');
  });

  it("opens realtime only after the initial session cursor is published", async () => {
    const shell = await readAdminShellSource();
    expect(shell).toContain("let disconnectRealtime");
    expect(shell).not.toContain("const disconnect = connectAdminRealtime()");
    expect(shell.indexOf("publishAdminStatus(nextStatus)")).toBeLessThan(shell.indexOf("connectAdminRealtime()"));
  });

  it("binds GitHub OAuth from existing Slack account rows instead of adding Slack ids", async () => {
    const shell = await readAdminShellSource();
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    expect(shell).toContain("startGitHubAccountDeviceAuthorization");
    expect(shell).toContain("githubAccountDeviceStartApiPath");
    expect(sessionView).toContain("GitHubBindPage");
    expect(sessionView).toContain("readGitHubBindSessionKey");
    expect(sessionView).toContain("github-bind-page");
    expect(sessionView.indexOf("readGitHubBindSessionKey")).toBeLessThan(sessionView.indexOf("readPermalinkSessionKey"));
    expect(shell).toContain("绑定 GitHub");
    expect(shell).toContain("重新绑定 GitHub");
    expect(shell).toContain("默认 PR 账号");
    expect(shell).toContain("设为默认 PR");
    expect(shell).toContain("buildFallbackGitHubAccounts");
    expect(shell).toContain("firstUserMessage");
    expect(shell).toContain("lastUserMessage");
    expect(shell).toContain("normalizeSlackIdentity");
    expect(shell).not.toContain("GitHub 未绑定");
    expect(shell).not.toContain('onEdit("", "")');
    expect(shell).not.toContain("Slack 用户 ID（U123...）");
    expect(shell).not.toContain("GitHubAuthorDialog");
    expect(shell).not.toContain("编辑作者");
    expect(shell).not.toContain("Commit 作者：姓名 <email@example.com>");
    expect(shell).not.toContain("历史 Commit 作者");
  });

  it("keeps the default GitHub PR account control from repeating the current account", async () => {
    const shell = await readAdminShellSource();
    const css = await fs.readFile(new URL("admin.css", adminUiRoot), "utf8");
    expect(shell).toContain("github-default-field");
    expect(shell).toContain("defaultSelectValue");
    expect(shell).toContain("selectableDefaultAccounts");
    expect(shell).toContain("选择候选 GitHub PR 账号");
    expect(shell).toContain("切换");
    expect(shell).not.toContain("github-default-current");
    expect(shell).not.toContain("只有当前账号可用");
    expect(shell).not.toContain("没有可切换账号");
    expect(shell).not.toContain("选择默认 PR GitHub 账号");
    expect(shell).not.toContain('<div className="summary-detail">{currentDefaultLabel}</div>');
    expect(shell).not.toContain("candidateAccounts");
    expect(css).toContain(".github-default-control { display: grid; grid-template-columns: auto minmax(0, 1fr) auto;");
    expect(css).toContain(".github-default-field { min-width: 0; display: contents;");
    expect(css).not.toContain(".github-default-control { grid-template-columns: 1fr;");
  });

  it("uses selectable package versions instead of a free-form publish ref input", async () => {
    const shell = await readAdminShellSource();
    const css = await fs.readFile(new URL("admin.css", adminUiRoot), "utf8");
    expect(shell).toContain("buildDeployTargetOptions");
    expect(shell).toContain("recentPackageVersions");
    expect(shell).toContain('id="deploy-package-target-select"');
    expect(shell).toContain('id="deploy-package-version-select"');
    expect(shell).toContain('body: JSON.stringify({');
    expect(shell).toContain("target: selectedDeployTarget");
    expect(shell).toContain("Package 版本");
    expect(shell).toContain("部署版本");
    expect(shell).toContain("当前版本");
    expect(shell).not.toContain("releaseRollbackRef");
    expect(shell).not.toContain("buildRollbackReleaseOptions");
    expect(shell).not.toContain("recentReleases.length ? recentReleases.map");
    expect(shell).not.toContain("最近已发布");
    expect(shell).not.toContain("暂无可回滚版本");
    expect(shell).not.toContain(">回滚<");
    expect(shell).not.toContain("recentMainCommits");
    expect(shell).not.toContain("origin/main");
    expect(shell).not.toContain('placeholder="提交 / 分支 / 标签"');
    expect(shell).not.toContain('const [ref, setRef] = useState("");');
    expect(css).toContain(".deploy-actions { display: grid; grid-template-columns: auto minmax(110px, 0.35fr) auto minmax(0, 1fr) auto;");
    expect(css).toContain(".deploy-target-field { min-width: 0; display: contents;");
    expect(css).not.toContain(".deploy-actions { grid-template-columns: 1fr;");
  });

  it("keeps session auth profile action detailed without expanding dense quota labels", async () => {
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    const authProfileDisplay = await fs.readFile(new URL("auth-profile-display.ts", adminUiRoot), "utf8");
    expect(authProfileDisplay).toContain("export function profileSessionActionLabel");
    expect(sessionView).toContain("profileSessionActionLabel(currentProfile)");
    expect(sessionView).toContain('className={"auth-profile-detail-button " + (blocked ? "danger" : "")}');
  });

  it("renders the account pool as structured profile cards instead of plain quota rows", async () => {
    const shell = await readAdminShellSource();
    const css = await fs.readFile(new URL("admin.css", adminUiRoot), "utf8");
    expect(shell).toContain("profile-card");
    expect(shell).toContain("profile-quota-metrics");
    expect(shell).toContain("profile-quota-metric");
    expect(shell).toContain("短窗");
    expect(css).toContain(".profile-card");
    expect(css).toContain(".profile-quota-metrics");
    expect(css).toContain(".profile-delete-button");
    expect(css).not.toContain(".profile-quota-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line);");
    expect(css).not.toContain(".profile-quota-metric { min-width: 0; display: grid; gap: 1px; padding: 5px 6px; background: #070b10;");
    expect(css).not.toContain(".profile-quota-metric + .profile-quota-metric");
    expect(css).not.toContain(".profile-plan-badge { flex: 0 0 auto; border:");
    expect(css).not.toContain(".profile-short-window { display: flex; gap: 6px; align-items: baseline; min-width: 0; padding: 3px 5px; border:");
    expect(shell).not.toContain('<div className="quota-grid">');
    expect(shell).not.toContain("ChatGPT Codex 账号");
  });

  it("gives operation page modules distinct boundaries without table-like internals", async () => {
    const shell = await readAdminShellSource();
    const css = await fs.readFile(new URL("admin.css", adminUiRoot), "utf8");
    expect(shell).toContain('className="ops-page"');
    expect(shell).toContain('className="view-grid ops-grid"');
    expect(shell).toContain('className="panel ops-panel"');
    expect(css).toContain(".ops-page");
    expect(css).toContain(".ops-grid");
    expect(css).toContain(".ops-panel");
    expect(css).toContain(".ops-panel > .panel-head");
    expect(css).toContain(".ops-panel .operation-list");
    expect(css).not.toContain(".ops-panel .operation-list { display: grid; gap: 1px; background: var(--line);");
    expect(css).not.toContain(".ops-panel .maintenance-grid { display: grid; gap: 1px; background: var(--line);");
  });

  it("does not render free-text search controls in the admin UI", async () => {
    const shell = await readAdminShellSource();
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    const combined = shell + "\n" + sessionView;
    expect(combined).not.toContain('type="search"');
    expect(combined).not.toContain("sessionSearch");
    expect(combined).not.toContain("session-search");
    expect(combined).not.toContain("筛选会话");
    expect(combined).not.toContain("筛选 Slack / GitHub 账号");
    expect(combined).not.toContain("setQuery");
  });

  it("opens Slack threads through a backend permalink resolver", async () => {
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    expect(sessionView).toContain("openSlackThread");
    expect(sessionView).toContain("slackThreadUrlApiPath");
    expect(sessionView).toContain("window.open");
    expect(sessionView).toContain("Slack Thread 跳转失败");
    expect(sessionView).not.toContain('href={session.threadUrl}');
  });

  it("prefers backend GitHub account identities over session fallback rows", async () => {
    const shell = await readAdminShellSource();
    expect(shell.indexOf("const accounts = status.githubAccounts?.accounts")).toBeLessThan(
      shell.indexOf("const fallback = buildFallbackGitHubAccounts(status)")
    );
  });

  it("keeps business UI free of imperative DOM rendering and event binding", async () => {
    const files = await listAdminUiSourceFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const relativePath = path.relative(repoRoot.pathname, file);
      if (relativePath.endsWith("src/admin-ui/main.tsx")) {
        continue;
      }
      const source = await fs.readFile(file, "utf8");
      for (const forbidden of ["getElementById", "querySelector", "innerHTML"]) {
        if (source.includes(forbidden)) {
          offenders.push(`${relativePath}:${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function readAdminShellSource(): Promise<string> {
  for (const candidate of ["admin-shell.tsx", "admin-shell.ts"]) {
    try {
      return await fs.readFile(new URL(candidate, adminUiRoot), "utf8");
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  throw new Error("admin-shell source is missing");
}

async function listAdminUiSourceFiles(): Promise<string[]> {
  const entries = await fs.readdir(adminUiRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name))
    .map((entry) => path.join(adminUiRoot.pathname, entry.name))
    .sort();
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
