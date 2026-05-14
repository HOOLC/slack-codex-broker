export interface ToolTraceDisplaySummary {
  readonly badgeLabel?: string | undefined;
  readonly title: string;
  readonly summary: string;
  readonly metadata: Record<string, string | number | boolean | null>;
}

export function summarizeToolTraceDisplay(options: {
  readonly eventType: string;
  readonly toolName?: string | undefined;
  readonly status?: string | undefined;
  readonly payload?: unknown;
  readonly fallbackTitle?: string | undefined;
  readonly fallbackSummary?: string | undefined;
}): ToolTraceDisplaySummary | undefined {
  const toolName = normalizeString(options.toolName ?? options.fallbackSummary ?? options.fallbackTitle);
  if (toolName !== "exec_command") {
    return undefined;
  }
  const payload = asRecord(options.payload);
  const slackSummary = summarizeSlackBrokerTrace({
    eventType: options.eventType,
    status: options.status,
    payload
  });
  if (slackSummary) {
    return slackSummary;
  }

  return summarizeExecCommandTrace({
    eventType: options.eventType,
    status: options.status,
    payload,
    fallbackTitle: toolName,
    fallbackSummary: options.fallbackSummary
  });
}

export function parseToolTraceDetail(detail: unknown): Record<string, unknown> | undefined {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    return detail as Record<string, unknown>;
  }

  const text = normalizeString(detail);
  if (!text) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    const command = extractJsonStringField(text, "command");
    const cmd = extractJsonStringField(text, "cmd");
    const cwd = extractJsonStringField(text, "cwd");
    const aggregatedOutput = extractJsonStringField(text, "aggregatedOutput");
    const error = extractJsonStringField(text, "error");
    const exitCode = extractJsonNumberField(text, "exitCode");
    const durationMs = extractJsonNumberField(text, "durationMs");
    const status = extractJsonStringField(text, "status");
    const compact = compactRecord({
      command,
      cmd,
      cwd,
      aggregatedOutput,
      error,
      exitCode,
      durationMs,
      status
    });
    return Object.keys(compact).length ? compact : undefined;
  }
}

export function mergeToolTracePayloads(...payloads: readonly unknown[]): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const payload of payloads) {
    const record = asRecord(payload);
    if (!record) {
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (value !== undefined && value !== null && merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

function summarizeSlackBrokerTrace(options: {
  readonly eventType: string;
  readonly status?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}): ToolTraceDisplaySummary | undefined {
  const payload = options.payload ?? {};
  const command = normalizeString(payload.command) || normalizeString(payload.cmd);
  if (!command) {
    return undefined;
  }
  const route = slackBrokerRoute(command);
  if (!route) {
    return undefined;
  }

  const data = extractCurlJsonData(command);
  const status = normalizeString(options.status ?? payload.status);
  const isResult = options.eventType === "agent_tool_result";
  const state = slackDeliveryState(isResult, status);

  if (route === "/slack/post-message") {
    const text = messageText(data?.text) || "发送 Slack 消息";
    const kind = normalizeString(data?.kind) || "progress";
    return {
      badgeLabel: "Bot",
      title: text,
      summary: `Slack ${kind} · ${state}`,
      metadata: compactMetadataRecord({
        semanticType: "slack_message",
        slackKind: kind,
        slackText: text,
        command,
        route
      })
    };
  }

  if (route === "/slack/post-file") {
    const filePath = normalizeString(data?.file_path);
    const comment = messageText(data?.initial_comment);
    const filename = filePath.split("/").filter(Boolean).at(-1) || "文件";
    return {
      badgeLabel: "Bot",
      title: comment || `上传 ${filename}`,
      summary: `Slack 文件 · ${filename} · ${state}`,
      metadata: compactMetadataRecord({
        semanticType: "slack_file",
        slackFilePath: filePath,
        slackText: comment,
        command,
        route
      })
    };
  }

  if (route === "/slack/post-state") {
    const kind = normalizeString(data?.kind) || "state";
    const reason = compactText(normalizeString(data?.reason), 220);
    return {
      badgeLabel: "状态",
      title: `记录 ${kind} 状态`,
      summary: reason || state,
      metadata: compactMetadataRecord({
        semanticType: "slack_state",
        slackKind: kind,
        slackText: reason,
        command,
        route
      })
    };
  }

  return undefined;
}

function slackDeliveryState(isResult: boolean, status: string): string {
  if (!isResult) {
    return "准备发送";
  }
  const normalized = status.toLowerCase();
  if (normalized === "failed" || normalized === "error") {
    return "失败";
  }
  return "已发送";
}

function slackBrokerRoute(command: string): "/slack/post-message" | "/slack/post-file" | "/slack/post-state" | undefined {
  if (command.includes("/slack/post-message")) {
    return "/slack/post-message";
  }
  if (command.includes("/slack/post-file")) {
    return "/slack/post-file";
  }
  if (command.includes("/slack/post-state")) {
    return "/slack/post-state";
  }
  return undefined;
}

function extractCurlJsonData(command: string): Record<string, unknown> | undefined {
  const body = unwrapShellCommand(command);
  const raw =
    extractCurlDataArgument(body, "'") ??
    extractCurlDataArgument(body, "\"") ??
    extractCurlDataBareArgument(body);
  if (!raw) {
    return undefined;
  }
  return parseCurlJsonData(raw);
}

function parseCurlJsonData(raw: string): Record<string, unknown> | undefined {
  const candidates = curlJsonDataCandidates(raw);
  for (const candidate of candidates) {
    try {
      const parsed = asRecord(JSON.parse(candidate));
      if (parsed) {
        return parsed;
      }
    } catch {}
  }

  for (const candidate of candidates) {
    const recovered = compactRecord({
      channel_id: extractJsonStringField(candidate, "channel_id"),
      thread_ts: extractJsonStringField(candidate, "thread_ts"),
      text: extractJsonStringField(candidate, "text"),
      kind: extractJsonStringField(candidate, "kind"),
      file_path: extractJsonStringField(candidate, "file_path"),
      initial_comment: extractJsonStringField(candidate, "initial_comment"),
      reason: extractJsonStringField(candidate, "reason")
    });
    if (Object.keys(recovered).length) {
      return recovered;
    }
  }

  return undefined;
}

function curlJsonDataCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  let current = raw.trim();
  for (let index = 0; index < 5; index += 1) {
    if (!current || seen.has(current)) {
      break;
    }
    seen.add(current);
    candidates.push(current);
    const next = unescapeShellQuotedArgument(current).trim();
    if (next === current) {
      break;
    }
    current = next;
  }
  return candidates;
}

function extractCurlDataArgument(command: string, quote: "'" | "\""): string | undefined {
  const escapedQuote = quote === "'" ? "'" : "\\\"";
  const pattern = new RegExp("(?:^|\\s)(?:-d|--data|--data-raw|--data-binary)\\s+" + escapedQuote + "([\\s\\S]*?)" + escapedQuote);
  return pattern.exec(command)?.[1];
}

function extractCurlDataBareArgument(command: string): string | undefined {
  return /(?:^|\s)(?:-d|--data|--data-raw|--data-binary)\s+(\{[\s\S]*\})(?:\s|$)/.exec(command)?.[1];
}

function unwrapShellCommand(command: string): string {
  const shell = command.match(/^\/(?:bin|usr\/bin|opt\/homebrew\/bin)\/(?:zsh|bash|sh)\s+-lc\s+"([\s\S]*)"$/);
  return shell ? unescapeShellQuotedArgument(shell[1] ?? "") : command;
}

function summarizeExecCommandTrace(options: {
  readonly eventType: string;
  readonly status?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
  readonly fallbackTitle: string;
  readonly fallbackSummary?: string | undefined;
}): ToolTraceDisplaySummary {
  const payload = options.payload ?? {};
  const rawCommand = normalizeString(payload.command);
  const command = rawCommand ? simplifyShellCommand(rawCommand) : "";
  const title = compactText(command || options.fallbackTitle, 160);
  const cwdLabel = summarizeCwd(
    (rawCommand ? extractShellCdPath(rawCommand) : "") ||
      normalizeString(payload.cwd)
  );
  const actionSummary = summarizeCommandActions(payload.commandActions);
  const exitCode = normalizeNumber(payload.exitCode);
  const durationMs = normalizeNumber(payload.durationMs);
  const outputPreview = summarizeOutput(payload.aggregatedOutput ?? payload.output ?? payload.error);
  const status = normalizeString(options.status ?? payload.status);
  const isResult = options.eventType === "agent_tool_result";
  const summaryParts = isResult
    ? [
        exitCode !== undefined ? `exit ${exitCode}` : statusLabel(status),
        durationMs !== undefined ? formatDuration(durationMs) : "",
        outputPreview ? `输出 ${outputPreview}` : "",
        outputPreview ? "" : actionSummary,
        outputPreview || actionSummary ? "" : cwdLabel
      ]
    : [
        actionSummary,
        cwdLabel ? `cwd ${cwdLabel}` : "",
        statusLabel(status)
      ];
  const summary = compactText(summaryParts.filter(Boolean).join(" · ") || options.fallbackSummary || "", 220);

  return {
    badgeLabel: "命令",
    title,
    summary,
    metadata: compactMetadataRecord({
      command: rawCommand,
      commandPreview: title,
      cwd: normalizeString(payload.cwd),
      cwdLabel,
      actionSummary,
      exitCode,
      durationMs,
      outputPreview
    })
  };
}

function simplifyShellCommand(command: string): string {
  const body = unwrapShellCommand(command);
  const cdPath = extractShellCdPath(body);
  const cdPrefix = cdPath ? body.match(/^cd\s+.+?\s+&&\s+/)?.[0] : undefined;
  return (cdPrefix ? body.slice(cdPrefix.length) : body).trim();
}

function extractShellCdPath(command: string): string {
  return command.match(/^\/(?:bin|usr\/bin|opt\/homebrew\/bin)\/(?:zsh|bash|sh)\s+-lc\s+"([\s\S]*)"$/)
    ? extractShellCdPath(unescapeShellQuotedArgument(command.match(/^\/(?:bin|usr\/bin|opt\/homebrew\/bin)\/(?:zsh|bash|sh)\s+-lc\s+"([\s\S]*)"$/)?.[1] ?? ""))
    : (command.match(/^cd\s+(.+?)\s+&&\s+/)?.[1] ?? "").trim();
}

function unescapeShellQuotedArgument(value: string): string {
  return value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function summarizeCwd(cwd: string): string {
  if (!cwd) {
    return "";
  }
  const workspaceIndex = cwd.indexOf("/workspace/");
  if (workspaceIndex >= 0) {
    return compactText(cwd.slice(workspaceIndex + "/workspace/".length), 80);
  }
  if (cwd.endsWith("/workspace")) {
    return "workspace";
  }
  return compactText(cwd.split("/").filter(Boolean).slice(-2).join("/"), 80);
}

function summarizeCommandActions(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }

  const firstType = normalizeString(asRecord(value[0])?.type);
  const label = actionTypeLabel(firstType);
  const names = value
    .map((entry) => normalizeString(asRecord(entry)?.name) || summarizePath(normalizeString(asRecord(entry)?.path)))
    .filter(Boolean)
    .slice(0, 3);
  const suffix = value.length > names.length ? ` +${value.length - names.length}` : "";
  return compactText([label, names.join(", ") + suffix].filter(Boolean).join(" "), 120);
}

function actionTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    read: "读取",
    search: "搜索",
    edit: "编辑",
    write: "写入",
    execute: "执行",
    test: "测试"
  };
  return labels[type] || (type ? `${type}` : "操作");
}

function summarizePath(value: string): string {
  if (!value) {
    return "";
  }
  return value.split("/").filter(Boolean).slice(-1)[0] ?? "";
}

function summarizeOutput(value: unknown): string {
  const text = normalizeString(value);
  if (!text) {
    return "";
  }
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return compactText(lines[0] ?? text.trim(), 160);
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    completed: "完成",
    done: "完成",
    failed: "失败",
    error: "失败",
    running: "运行中",
    inprogress: "运行中",
    inflight: "运行中",
    started: "已开始"
  };
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  return labels[normalized] || "";
}

function formatDuration(value: number): string {
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

function messageText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function compactMetadataRecord(record: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const compacted: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (value !== "") {
        compacted[key] = value;
      }
    }
  }
  return compacted;
}

function extractJsonStringField(text: string, key: string): string {
  const match = text.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) {
    return "";
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1] ?? "";
  }
}

function extractJsonNumberField(text: string, key: string): number | undefined {
  const match = text.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? normalizeNumber(match[1]) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
