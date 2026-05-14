# Admin Session Performance

## Goal

The admin session surface should behave like a live agent session UI, not a
database dump. The first screen must be fast even when there are hundreds of
sessions and each session has hundreds or thousands of trace events.

## Current State

The React shell loads `/admin/api/sessions` first, then renders the selected
session and loads `/admin/api/sessions/:key/timeline`.

The remaining problems are data-contract problems:

- session summaries still derive token usage from raw turn usage records at read
  time;
- timeline reads return a full session slice instead of a latest page with a
  cursor;
- timeline pagination is still raw-row oriented in places, so hidden trace rows
  can make a `limit=30` response render far fewer than 30 readable activity
  rows;
- the session detail page exposes an older-page button, but scrolling to the
  top of the activity list does not automatically load history;
- trace statistics are derived by scanning the fetched timeline payload;
- the detail page has no explicit "load older" path, so one old or large
  session can make the first usable view slow.

## Target Design

- `/admin/api/sessions` returns compact session list summaries only. It must not
  read agent trace events, must not aggregate raw turn usage records for every
  request, and must not include detail-only arrays such as background job rows or
  workspace paths.
- Read-only admin endpoints must not call `SessionManager.load()` or touch every
  session workspace directory. Startup and session creation own directory
  creation; read paths must stay DB-only.
- Token usage and trace composition used by session UI are stored as redundant
  per-session summaries when usage or trace rows are written.
- `/admin/api/sessions/:key/timeline` reads from newest to oldest with a bounded
  limit. The response includes a cursor for loading older events.
- Timeline `limit` is a visible-event contract: after hiding token counters,
  turn bookkeeping, and tool-call rows superseded by tool results, the API fills
  the page with up to the requested number of readable events before returning.
- The initial timeline page is the newest page across visible timeline events.
  Synthetic state events such as session creation, current inbound messages,
  background jobs, and turn signals are session metadata and must not be injected
  into the paginated agent timeline.
- The first timeline page is rendered in chronological order inside that page,
  but it is obtained by reading the newest rows first.
- The React detail view fetches only the selected session's first timeline page.
  It starts with a small latest page and prepends older pages only when the user
  asks for more.
- The React detail view also treats the activity list as an infinite history:
  scrolling near the top loads older pages, and an underfilled first screen keeps
  backfilling until it has enough visible rows or the API reports no more.
- Timeline page rows carry summaries only. Full trace `detail` payloads are
  loaded per event when the user opens a row's detail disclosure.
- Realtime events append to the loaded timeline page without forcing a full
  timeline reload.
- Read-heavy admin API responses include `Server-Timing` and
  `X-Admin-Duration-Ms` so browser/network tooling can show whether the backend
  or frontend is slow.

## Acceptance Criteria

- `listSessionSummaries()` can run without `listAgentTraceEvents()` and without
  raw `listAgentTurnUsage()` aggregation.
- `listSessionSummaries()` does not send detail-only fields such as
  `workspacePath`, `backgroundJobs`, or `failedBackgroundJobs`.
- `listSessionSummaries()` and the initial session timeline request do not call
  `SessionManager.load()` on the read path.
- `GET /admin/api/sessions/:key/timeline?limit=50` returns at most 50 visible
  timeline events plus pagination metadata.
- If the newest raw trace rows are hidden from the UI, the timeline endpoint
  continues scanning older rows so the returned page is not starved by hidden
  bookkeeping rows.
- The first page contains only the newest agent trace events. Synthetic session
  state is exposed through the session summary payload, not as timeline rows.
- `before_sequence` loads older trace rows and does not reread the newest page.
- Timeline responses include trace summary data from the per-session redundant
  summary, not from the current page size.
- The React session detail initial request includes a bounded `limit`.
- The React session detail has an explicit `加载更早活动` action when the API says
  older activity exists.
- The React session detail automatically loads older activity when the timeline
  scroll container reaches the top or the first loaded page does not fill the
  visible area.
- Loading older activity prepends events while preserving the viewer's current
  visual anchor. The timeline records the previous `scrollHeight` and
  `scrollTop`, then adds the inserted height delta back to `scrollTop` after the
  older page renders. The record the user was reading must not jump.
- The first timeline page does not inline large trace details; details are lazy
  loaded by event id.
- Timeline, sessions, overview, usage, and status responses expose backend
  duration headers for request-level tracing.
- `pnpm test` and `pnpm build` pass.
