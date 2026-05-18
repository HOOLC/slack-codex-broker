# macOS LaunchDaemon Supervision

## Goal

The production admin, worker, and public admin tunnel must survive missing GUI
login sessions. They must be supervised by the system launchd domain, not by
per-user LaunchAgents under `gui/<uid>`.

## Current State

The bootstrap and deployment code writes admin and worker plists under
`~/Library/LaunchAgents` and restarts them through `gui/<uid>`. The public admin
tunnel was also installed as a LaunchAgent. This works only while the expected
GUI launchd domain exists. On the production VM the GUI domain can disappear or
be unavailable over SSH, leaving admin, worker, and cloudflared unregistered
even though their plist files still exist.

Manual `nohup` recovery can bring the processes back, but it is not a reliable
service boundary: it does not restart after crashes or boot, and it is not what
deployment code checks.

## Target Design

- Admin runs as a LaunchDaemon in the `system` launchd domain.
- Worker runs as a LaunchDaemon in the `system` launchd domain.
- The cloudflared admin tunnel runs as a LaunchDaemon in the `system` launchd
  domain when a tunnel token is configured.
- Daemon plists live in `/Library/LaunchDaemons` by default.
- Daemon processes run as the operator user through `UserName`, with `HOME`
  pointing at that user's home directory.
- Release deployment restarts and health checks use `system/<label>`.
- Bootstrap removes or disables the old per-user LaunchAgent files so there is
  not a hidden stale supervisor path.
- The existing current symlink design remains unchanged: admin launchd points at
  `current-admin`, worker launchd points at `current-worker`.
- Worker startup maintenance must not require reading every historical inbound
  message into JavaScript before the worker can answer health checks. Any
  startup backfill must use a bounded/indexed query path.

## Acceptance Criteria

- `macos-bootstrap` writes admin and worker plist files to a LaunchDaemon
  directory, not `~/Library/LaunchAgents`.
- The generated daemon plist contains `UserName`, `RunAtLoad`, `KeepAlive`,
  `WorkingDirectory`, stdout/stderr paths, and the same launcher/env/entry-point
  wiring as before.
- If `CLOUDFLARED_TUNNEL_TOKEN` is present, bootstrap writes and starts a
  cloudflared LaunchDaemon pointing at `http://127.0.0.1:3000`.
- Bootstrap restarts services with `launchctl bootout/bootstrap/kickstart`
  against `system`, not `gui/<uid>`.
- `ReleaseDeploymentService` restarts admin and worker through the `system`
  launchd domain and checks `system/<label>` for loaded state.
- Production migration installs system LaunchDaemons for admin, worker, and
  cloudflared, removes the old LaunchAgent files, and leaves public admin,
  local admin, and worker health checks green.
- Worker `readyz` responds after restart without being blocked by historical
  inbound-message backfill.
- Tests and build pass.
