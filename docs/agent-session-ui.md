# Agent Session UI

## Goal

Make the session surface feel like a real agent session product UI, not an
admin database inspector.

The page should answer these questions first:

1. What is the agent working on?
2. Is it running, waiting, blocked, or done?
3. What has happened in the agent timeline?
4. What can the user do now: open the Slack thread, continue, switch account,
   bind GitHub, cancel work, or reset the session?

Operational and debug metadata still exists, but it should not be the primary
reading path.

## Current State

The current React page already has the right data and core controls, but the
information architecture still reads like admin tooling:

- the left column is labeled `会话索引`;
- the detail panel is labeled `会话详情`;
- the selected session header is a compact table-like row;
- the timeline title is `Agent 活动时间线`;
- the right rail uses backend-oriented section names such as `操作`,
  `运行状态`, `消息 / 任务`, `活动构成`, and `调试信息`;
- the visual hierarchy is mostly panel borders and table separators.

That makes the UI useful for operators, but weak for someone following one
agent run from a Slack thread.

## Target Design

The session page is an agent workbench:

- Left: `Agent 会话` stream, optimized for selecting a session quickly.
- Right top: a compact session summary strip showing the current task, current
  state, channel, latest activity time, token usage, and active job count
  without pushing the timeline down. There is no standalone `Agent 工作台`
  title bar because it adds no information.
- Main axis: `工作时间线`. This is the primary artifact and should occupy the
  largest area.
- The workbench should feel like one open workspace, not panels nested inside
  panels. The detail surface should keep only the page-level shell, the two
  column split, and first-level section boundaries. The session summary strip,
  timeline frame, and right rail frames are sibling first-level blocks, not
  frames nested inside another visible frame. Their gutters and edges must align
  as one layout system; removing frames must not leave floating titles or
  mismatched padding.
- Timeline is an agent transcript, not a database table and not a trace-event
  card wall. The primary reading path is the conversation: user input,
  assistant output, and the agent's tool work between them.
- User and bot items read like messages. Ordinary assistant messages are subdued
  internal output. Tool calls read like compact work steps, not cards.
  Runtime/session/system items read like notification rows. Raw event
  type, status, role, and tool metadata are secondary context.
- Message body truncation is a visual layout concern. User messages,
  assistant messages, and Bot Slack messages should keep their message text in
  the rendered data and use CSS line clamping for multiline overflow. They
  should not be shortened by arbitrary character-count slicing in display
  mappers.
- Slack send tool calls are bot output. `/slack/post-message` and
  `/slack/post-file` should render as `Bot` messages because that is what humans
  see in Slack, not as generic tool calls. This must work for both new events
  with semantic metadata and older/raw `exec_command` events where the Slack
  route only exists inside the stored command detail.
- Slack post-message extraction must read the actual posted text, including
  historical shell forms that split JSON strings with adjacent shell quotes or
  send JSON through `-d @- <<EOF` heredocs. A Bot message must not fall back to
  meaningless text such as `发送 Slack 消息` just because the command parser missed
  the payload.
- User messages and Bot messages posted to Slack are the primary conversation
  path. Bot messages should sit at roughly the same visual level as user
  messages, with cyan identity treatment.
- Ordinary assistant messages are internal runtime output and should be visually
  weaker than Bot messages posted to Slack.
- Status is secondary metadata. It should not be the strongest text in a row;
  content title/message should lead.
- Tool calls distinguish running, success, and failure with restrained tone
  differences. A failed tool call must not look the same as a successful one.
- Detail inspection is a debug affordance. It should stay available as a small
  inline icon, not as a separate visible text row.
- Runtime-generated inputs such as background job notifications, unexpected turn
  stop reminders, recovered thread batches, and admin resets are not user
  messages even if old trace rows stored `role=user`.
- Timeline visual semantics follow the agent flow without forcing the reader to
  parse raw trace type names.
- Right rail: action and context panels:
  - `接管 / 链接` for Slack thread, standalone view, account switch, GitHub
    binding, and reset;
  - `当前状态` for active turn, pending input, and running jobs;
  - `用量` for token consumption;
  - `等待输入 / 后台任务` only when there is pending input or active jobs;
  - `时间线统计` for collapsed activity composition;
  - `技术上下文` for channel id, root ts, agent id, session key, auth profile,
    and other debug data.

The UI keeps the existing controls and APIs. This is an information-architecture
and visual hierarchy refactor, not a behavior rewrite.

## Acceptance Criteria

- Session list title is `Agent 会话`, not `会话索引`.
- Session detail does not show a standalone title bar. The selected session
  summary is the first visible detail block.
- The selected session has a compact agent-session summary with task title,
  Slack request, state, channel, latest activity, token usage, and job count.
  It must not use a large two-row statistics grid or tall hero spacing that
  consumes the first screen.
- Timeline is labeled `工作时间线` and remains the main scrollable region.
- The selected session workbench avoids nested visible frames. The outer detail
  surface does not draw a frame around inner frames. The session summary is a
  first-level header block; the timeline keeps one visible frame and title bar,
  and right-rail sections keep one visible frame each.
- Header, summary, timeline, and right-rail frames share the same horizontal
  gutter. The body columns must not add an extra inset that breaks alignment.
- Timeline markup uses agent-session primitives such as `agent-transcript`,
  `agent-message`, `agent-message-body`, `agent-tool-step`, and
  `agent-system-note`, not a three-column table row and not per-event trace
  bubbles.
- User/Bot messages are the primary readable content. Tool calls are compact,
  visually light work steps. Runtime/session/system events are notification rows,
  not message bubbles.
- User, Assistant, and Bot message bodies are not character-count truncated by
  `getTimelineEventDisplay` or trace display summarizers. Multiline overflow is
  controlled by CSS line clamp so width, font, device size, and language decide
  what is visible.
- Slack posting tools render as Bot messages. Ordinary assistant messages remain
  visible but subdued. Raw historical `exec_command` Slack posts without
  `metadata.semanticType` still render as Bot messages.
- Slack posting tools display the posted Slack text, not the curl command and not
  a generic `发送 Slack 消息` placeholder. This includes shell-concatenated text
  around inline code/backticks and heredoc request bodies.
- Bot messages share the primary message-body treatment with user messages and
  use cyan avatar, speaker, and left accent to make Slack output clear.
- Tool status is visually secondary and appears after the tool content. Tool
  rows use different restrained tones for success, running, and failure.
- Runtime/session notice badges are subdued so the title/summary remains the
  reading focus.
- Detail inspection uses a muted inline icon by default and opens an in-message
  debug panel below the current item. It must not create its own timeline row,
  use visible `查看详情` text, or rely on an absolute overlay that can be clipped
  by the timeline scroll container or covered by neighboring rows.
- Background job and runtime reminder inputs render as Runtime/session notes,
  not as `用户` messages.
- Completed, failed, or cancelled background jobs are historical records, not
  current work. They must not create a `后台任务` state badge, a `Jobs N` list
  pill, a hero task stat, or the right-rail job panel. Only active job states
  (`registered` / `running`) can do that.
- Timeline CSS uses a transcript layout with role avatars, message bodies, and
  compact work steps instead of `grid-template-columns: 72px 90px minmax(0, 1fr)`
  or trace-style `timeline-bubble` / `timeline-rail` UI.
- The right rail uses product/session language: `接管 / 链接`, `当前状态`,
  `用量`, `等待输入 / 后台任务`, `时间线统计`, and `技术上下文`.
- Backend/admin-oriented labels such as `操作`, `运行状态`, `消息 / 任务`,
  `活动构成`, and `调试信息` are not used as session detail section headings.
- Existing session behavior remains available: open Slack thread, standalone
  session page, auth profile switch/auto allocation, GitHub binding, reset,
  job cancellation, timeline loading, and token usage.
- Mobile layout keeps a single page scroll with the timeline before secondary
  context.
- `pnpm test` and `pnpm build` pass.
