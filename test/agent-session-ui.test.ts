import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { agentTranscriptKind, agentTranscriptSpeaker } from "../src/admin-ui/agent-transcript-display.js";

const adminUiRoot = new URL("../src/admin-ui/", import.meta.url);

describe("agent session UI", () => {
  it("documents the agent workbench target", async () => {
    const doc = await fs.readFile(new URL("../docs/agent-session-ui.md", import.meta.url), "utf8");

    expect(doc).toContain("real agent session product UI");
    expect(doc).toContain("There is no standalone `Agent 工作台`");
    expect(doc).toContain("compact session summary strip");
    expect(doc).toContain("one open workspace");
    expect(doc).toContain("工作时间线");
    expect(doc).toContain("agent transcript");
    expect(doc).toContain("agent-tool-step");
    expect(doc).toContain("接管 / 链接");
    expect(doc).toContain("技术上下文");
  });

  it("uses agent-session language instead of backend admin section labels", async () => {
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    const css = await fs.readFile(new URL("admin.css", adminUiRoot), "utf8");

    expect(sessionView).toContain("AgentSessionHero");
    expect(sessionView).toContain("Agent 会话");
    expect(sessionView).not.toContain("Agent 工作台");
    expect(sessionView).toContain("工作时间线");
    expect(sessionView).toContain("接管 / 链接");
    expect(sessionView).toContain("当前状态");
    expect(sessionView).toContain("等待输入 / 后台任务");
    expect(sessionView).toContain("时间线统计");
    expect(sessionView).toContain("技术上下文");
    expect(sessionView).not.toContain("会话索引");
    expect(sessionView).not.toContain("会话详情");
    expect(sessionView).not.toContain("Agent 活动时间线");
    expect(sessionView).not.toContain('<div className="mini-title">操作</div>');
    expect(sessionView).not.toContain('<div className="mini-title">运行状态</div>');
    expect(sessionView).not.toContain('<div className="mini-title">消息 / 任务</div>');
    expect(sessionView).not.toContain('<div className="mini-title">活动构成</div>');
    expect(sessionView).not.toContain('<div className="mini-title">调试信息</div>');

    expect(css).toContain(".agent-session-hero");
    expect(css).toContain(".agent-session-stat-grid");
    expect(css).toContain(".agent-session-stat-grid { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 6px; align-content: center; justify-content: flex-end; }");
    expect(css).toContain(".agent-session-stat { min-width: 0; display: inline-flex; align-items: baseline;");
    expect(css).not.toContain("grid-template-columns: minmax(0, 1fr) minmax(360px, 0.86fr)");
    expect(css).not.toContain(".agent-session-stat { min-width: 0; display: grid; gap: 1px; align-content: center; padding: 6px 0; border-top");
    expect(css).toContain(".session-detail-panel { border: 0; background: transparent; overflow: hidden; }");
    expect(sessionView).not.toContain('<div className="panel-title">Agent 工作台</div>');
    expect(css).not.toContain(".session-detail-panel > .panel-head");
    expect(css).toContain(".session-detail-panel > .panel-body { flex: 1; min-height: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }");
    expect(css).toContain(".session-inspector { height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); gap: 14px; align-items: stretch; padding: 0; background: #070b10; }");
    expect(css).toContain(".agent-session-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 0.72fr); gap: 10px; align-items: center; padding: 7px 10px; border: 1px solid rgba(42,56,70,0.78); border-radius: 4px;");
    expect(css).toContain(".session-timeline-panel { border: 1px solid rgba(42,56,70,0.78); background: #0b1118; overflow: hidden; border-radius: 4px; }");
    expect(css).toContain(".session-side-column .mini-panel { min-height: 0; background: #0b1118; overflow: hidden; border: 1px solid rgba(42,56,70,0.78); border-radius: 4px; }");
    expect(css).toContain(".session-timeline-panel .mini-title { padding: 5px 7px; border-bottom: 1px solid rgba(42,56,70,0.68); background: rgba(16,24,33,0.48); }");
    expect(css).not.toContain(".session-inspector .mini-panel { min-width: 0; border-color: rgba(42,56,70,0.82); background: #0b1118; }");
    expect(css).not.toContain(".session-side-column .mini-panel { min-height: 0; background: transparent; overflow: visible; border: 0;");
    expect(css).toContain(".agent-session-request");
    expect(css).toContain(".agent-transcript");
    expect(css).toContain(".agent-message");
    expect(css).toContain(".agent-message-body");
    expect(css).toContain(".agent-message-bot");
    expect(css).toContain(".agent-message-user .agent-message-body, .agent-message-bot .agent-message-body { padding: 10px 12px; border: 1px solid rgba(42,56,70,0.86); background: #0c1219; }");
    expect(css).toContain(".agent-message-bot .agent-message-body { border-left: 3px solid var(--cyan); box-shadow: inset 0 0 0 1px rgba(61,181,199,0.14); }");
    expect(css).toContain(".agent-message-bot .agent-speaker { color: var(--cyan); font-size: 11px; }");
    expect(css).toContain(".agent-message-user .agent-message-content p, .agent-message-bot .agent-message-content p");
    expect(css).toContain("-webkit-line-clamp: 8");
    expect(css).toContain(".agent-message-bot .agent-message-content p { color: var(--text); font-size: 14px; font-weight: 700; line-height: 1.54; }");
    expect(css).toContain(".agent-message-assistant .agent-message-content p {");
    expect(css).toContain("-webkit-line-clamp: 4");
    expect(css).toContain(".agent-message-assistant .agent-message-body");
    expect(css).toContain(".agent-tool-step");
    expect(css).toContain(".agent-message-body { position: relative; min-width: 0; color: var(--muted); }");
    expect(css).toContain(".agent-tool-step { display: grid; grid-template-columns: minmax(0, 1fr) auto auto;");
    expect(css).toContain(".agent-tool-status");
    expect(css).toContain(".agent-message-tool.good .agent-message-body { border-left-color: rgba(60,179,113,0.38); }");
    expect(css).toContain(".agent-message-tool.warn .agent-message-body { border-left-color: rgba(212,160,23,0.38); }");
    expect(css).toContain(".agent-message-tool.danger .agent-message-body { border-left-color: rgba(224,108,92,0.5); }");
    expect(css).toContain(".agent-tool-step.good .agent-tool-status { color: var(--green); }");
    expect(css).toContain(".agent-tool-step.danger .agent-tool-status { color: var(--red); }");
    expect(css).toContain(".agent-message-tool .agent-message-avatar { display: none; }");
    expect(css).toContain(".agent-message-tool .agent-message-head { display: none; }");
    expect(css).toContain(".agent-message-tool .agent-message-body { padding: 1px 0 1px 10px; border: 0;");
    expect(css).toContain(".agent-system-note");
    expect(css).toContain(".agent-notice");
    expect(css).toContain(".agent-notice .badge { opacity: 0.45; filter: saturate(0.62); }");
    expect(css).toContain(".trace-details-button { display: grid; place-items: center; width: 14px; height: 14px;");
    expect(css).toContain(".trace-details-button:hover, .trace-details-button.open { color: var(--cyan); opacity: 0.72; }");
    expect(css).toContain(".trace-detail-panel { width: 100%; margin: 8px 0 0; padding: 6px 8px;");
    expect(css).not.toContain(".trace-details pre { position: absolute;");
    expect(css).not.toContain("top: 18px; z-index: 20; width: min(680px");
    expect(sessionView).toContain("setDetailOpen");
    expect(sessionView).toContain('className="trace-detail-panel"');
    expect(css).toContain(".agent-message-system .agent-message-avatar, .agent-message-session .agent-message-avatar { display: none; }");
    expect(css).toContain(".agent-message-system .agent-message-body, .agent-message-session .agent-message-body { padding: 0; border: 0; background: transparent; }");
    expect(css).not.toContain("grid-template-columns: 72px 90px minmax(0, 1fr)");
    expect(css).not.toContain(".timeline-bubble");
    expect(css).not.toContain(".timeline-rail");
  });

  it("renders timeline rows as an agent transcript instead of trace bubbles", async () => {
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");

    expect(sessionView).toContain("agentTranscriptKind");
    expect(sessionView).toContain('className="agent-transcript"');
    expect(sessionView).toContain('className={"agent-message agent-message-"');
    expect(sessionView).toContain('className="agent-message-avatar"');
    expect(sessionView).toContain('className="agent-message-body"');
    expect(sessionView).toContain('className={"agent-tool-step " + toolTone}');
    expect(sessionView).toContain('className="agent-tool-status"');
    expect(sessionView).toContain('aria-label="查看详情"');
    expect(sessionView).toContain('className="trace-details-icon"');
    expect(sessionView).not.toContain("<summary>查看详情</summary>");
    expect(sessionView).not.toContain("<details className=\"trace-details\"");
    expect(sessionView).toContain('className="agent-notice"');
    expect(sessionView).toContain('className="agent-notice-kind"');
    expect(sessionView).not.toContain("timelineEventKind");
    expect(sessionView).not.toContain('className="timeline-rail"');
    expect(sessionView).not.toContain('className="timeline-bubble"');
    expect(sessionView).not.toContain('<span>{fmtTime(event.at)}</span>');
  });

  it("classifies broker runtime inputs as Runtime notes even when old rows stored role=user", () => {
    const backgroundJobEvent = {
      type: "agent_input_received",
      role: "user",
      metadata: {
        source: "background_job_event"
      },
      title: "PR #1873 d13b3c0: checks 13 pass",
      summary: "watch_ci · job_completed · Job 13122469"
    };
    expect(agentTranscriptKind(backgroundJobEvent)).toBe("system");
    expect(agentTranscriptSpeaker(agentTranscriptKind(backgroundJobEvent), backgroundJobEvent)).toBe("Runtime");

    expect(agentTranscriptKind({
      type: "agent_input_received",
      role: "user",
      metadata: {
        source: "unexpected_turn_stop"
      }
    })).toBe("system");

    expect(agentTranscriptKind({
      type: "agent_input_received",
      role: "user",
      metadata: {
        source: "admin_session_reset"
      }
    })).toBe("session");
  });

  it("classifies Slack posting tool events as bot messages instead of tool calls", () => {
    const command = "/bin/zsh -lc \"curl -sS -X POST http://127.0.0.1:3001/slack/post-message -H 'content-type: application/json' -d '{\\\"channel_id\\\":\\\"C123\\\",\\\"thread_ts\\\":\\\"111.222\\\",\\\"text\\\":\\\"已经合并并部署。\\\",\\\"kind\\\":\\\"final\\\"}'\"";
    const slackPostEvent = {
      type: "agent_tool_result",
      toolName: "exec_command",
      metadata: {
        semanticType: "slack_message",
        slackKind: "final",
        slackText: "已经合并并部署。"
      }
    };

    expect(agentTranscriptKind(slackPostEvent)).toBe("bot");
    expect(agentTranscriptSpeaker(agentTranscriptKind(slackPostEvent), slackPostEvent)).toBe("Bot");

    expect(agentTranscriptKind({
      type: "agent_tool_result",
      title: "工具结果",
      summary: "exec_command",
      status: "completed",
      toolName: "exec_command",
      detail: JSON.stringify({
        command,
        exitCode: 0,
        durationMs: 810,
        aggregatedOutput: "{\"ok\":true}"
      })
    })).toBe("bot");

    expect(agentTranscriptKind({
      type: "agent_tool_result",
      toolName: "exec_command",
      metadata: {
        semanticType: "slack_file",
        slackFilePath: "/tmp/report.png"
      }
    })).toBe("bot");

    expect(agentTranscriptKind({
      type: "agent_tool_result",
      toolName: "exec_command",
      detail: "curl -sS -X POST http://127.0.0.1:3001/slack/post-file -H 'content-type: application/json' -d '{\"file_path\":\"/tmp/report.png\",\"initial_comment\":\"报告\"}'"
    })).toBe("bot");

    expect(agentTranscriptKind({
      type: "agent_tool_result",
      toolName: "exec_command",
      metadata: {
        semanticType: "slack_state",
        slackKind: "wait"
      }
    })).toBe("session");

    expect(agentTranscriptKind({
      type: "agent_tool_result",
      status: "completed",
      toolName: "exec_command",
      detail: "curl -sS -X POST http://127.0.0.1:3001/slack/post-state -H 'content-type: application/json' -d '{\"kind\":\"wait\",\"reason\":\"等待 CI\"}'"
    })).toBe("session");
  });
});
