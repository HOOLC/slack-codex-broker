import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubPrIdentityService } from "../src/services/github-pr-identity-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { SlackCoauthorService } from "../src/services/slack/slack-coauthor-service.js";
import { StateStore } from "../src/store/state-store.js";

describe("SlackCoauthorService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, {
      recursive: true,
      force: true
    })));
  });

  it("prompts once per candidate revision when selected co-authors are missing GitHub OAuth bindings", async () => {
    const { stateDir, sessions, githubPrIdentity } = await createHarness();
    const session = await sessions.ensureSession("C123", "111.222");
    const postEphemeral = vi.fn(async () => "111.333");
    const service = new SlackCoauthorService({
      sessions,
      githubPrIdentity,
      slackApi: {
        getUserIdentity: vi.fn(async () => ({
          userId: "U123",
          mention: "<@U123>",
          realName: "Alice Example"
        })),
        postEphemeral,
        openView: vi.fn()
      } as never
    });

    await service.noteIncomingSlackInput(session, {
      source: "thread_reply",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "111.223",
      userId: "U123",
      senderKind: "user",
      text: "please commit this"
    });

    const first = await service.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(test): demo"
    });
    expect(first.status).toBe("noop");
    expect(first.message).toContain("missing GitHub OAuth binding");
    expect(postEphemeral).toHaveBeenCalledTimes(1);

    const second = await service.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(test): demo"
    });
    expect(second.status).toBe("noop");
    expect(second.message).toContain("missing GitHub OAuth binding");
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    await expect(fs.readdir(path.join(stateDir, "github-author-mappings"))).rejects.toThrow();
  });

  it("uses GitHub OAuth bindings to resolve commit trailers without manual author inputs", async () => {
    const { sessions, githubPrIdentity } = await createHarness();
    const session = await sessions.ensureSession("C555", "222.333");
    await githubPrIdentity.upsertBinding({
      slackUserId: "U1",
      githubLogin: "alice",
      githubUserId: 101,
      githubEmail: "alice@github.example",
      githubName: "Alice GitHub",
      token: "alice-token",
      scopes: ["repo", "read:user", "user:email"]
    });
    await githubPrIdentity.upsertBinding({
      slackUserId: "U2",
      githubLogin: "bob",
      githubUserId: 102,
      githubEmail: "bob@github.example",
      githubName: "Bob GitHub",
      token: "bob-token",
      scopes: ["repo", "read:user", "user:email"]
    });

    const identities = new Map([
      ["U1", {
        userId: "U1",
        mention: "<@U1>",
        realName: "Alice Example",
        email: "alice@slack.example"
      }],
      ["U2", {
        userId: "U2",
        mention: "<@U2>",
        displayName: "Bob Example",
        email: "bob@slack.example"
      }]
    ]);
    const openView = vi.fn(async () => {});
    const service = new SlackCoauthorService({
      sessions,
      githubPrIdentity,
      slackApi: {
        getUserIdentity: vi.fn(async (userId: string) => identities.get(userId) ?? null),
        postEphemeral: vi.fn(async () => "111.444"),
        openView
      } as never
    });

    let latestSession = await service.noteIncomingSlackInput(session, {
      source: "thread_reply",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "222.334",
      userId: "U1",
      senderKind: "user",
      text: "first request"
    });
    latestSession = await service.noteIncomingSlackInput(latestSession, {
      source: "thread_reply",
      channelId: latestSession.channelId,
      rootThreadTs: latestSession.rootThreadTs,
      messageTs: "222.335",
      userId: "U2",
      senderKind: "user",
      text: "second request"
    });

    await service.handleInteractivePayload({
      type: "block_actions",
      trigger_id: "trigger-1",
      actions: [
        {
          action_id: "coauthor_configure",
          value: JSON.stringify({
            session_key: latestSession.key,
            candidate_revision: latestSession.coAuthorCandidateRevision
          })
        }
      ]
    });

    expect(openView).toHaveBeenCalledTimes(1);
    const modalView = (openView.mock.calls[0] as unknown as [Record<string, unknown>])?.[0]?.view as Record<string, unknown>;
    expect(modalView).toMatchObject({
      callback_id: "coauthor_confirm"
    });
    expect((modalView.blocks as Array<Record<string, unknown>>).filter((block) => String(block.block_id || "").startsWith("author__"))).toEqual([]);

    await service.handleInteractivePayload({
      type: "view_submission",
      user: { id: "U1" },
      view: {
        private_metadata: JSON.stringify({
          session_key: latestSession.key,
          candidate_revision: latestSession.coAuthorCandidateRevision
        }),
        state: {
          values: {
            contributors: {
              selected: {
                selected_options: [
                  { value: "U1" },
                  { value: "U2" }
                ]
              }
            }
          }
        }
      }
    });

    const resolved = await service.resolveCommitCoauthors({
      cwd: latestSession.workspacePath,
      commitMessage: "feat(slack): add coauthors",
      primaryAuthorEmail: "broker@example.com"
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.commitMessage).toContain("Co-authored-by: Alice GitHub <alice@github.example>");
    expect(resolved.commitMessage).toContain("Co-authored-by: Bob GitHub <bob@github.example>");
  });

  it("reports unbound selected users instead of asking for manual GitHub authors", async () => {
    const { sessions, githubPrIdentity } = await createHarness();
    const session = await sessions.ensureSession("C777", "333.444");
    const postEphemeral = vi.fn(async () => "111.555");
    const openView = vi.fn(async () => {});
    const service = new SlackCoauthorService({
      sessions,
      githubPrIdentity,
      slackApi: {
        getUserIdentity: vi.fn(async (userId: string) => {
          if (userId !== "U1") return null;
          return {
            userId: "U1",
            mention: "<@U1>",
            realName: "Kewei Hua"
          };
        }),
        postEphemeral,
        openView
      } as never
    });

    const latestSession = await service.noteIncomingSlackInput(session, {
      source: "thread_reply",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "333.445",
      userId: "U1",
      senderKind: "user",
      text: "please commit this"
    });

    await service.handleInteractivePayload({
      type: "block_actions",
      trigger_id: "trigger-2",
      actions: [
        {
          action_id: "coauthor_configure",
          value: JSON.stringify({
            session_key: latestSession.key,
            candidate_revision: latestSession.coAuthorCandidateRevision
          })
        }
      ]
    });

    const modalView = (openView.mock.calls[0] as unknown as [Record<string, unknown>])?.[0]?.view as Record<string, unknown>;
    expect((modalView.blocks as Array<Record<string, unknown>>).filter((block) => String(block.block_id || "").startsWith("author__"))).toEqual([]);

    const status = await service.configureSessionCoauthors({
      cwd: latestSession.workspacePath,
      userIds: ["U1"]
    });
    expect(status?.missingSelectedUserIds).toEqual(["U1"]);
    expect(status?.needsUserInput).toBe(true);

    const resolved = await service.resolveCommitCoauthors({
      cwd: latestSession.workspacePath,
      commitMessage: "feat(slack): unresolved"
    });
    expect(resolved.message).toContain("missing GitHub OAuth binding");
    expect(postEphemeral).toHaveBeenCalled();
  });

  it("allows unresolved co-authors to be ignored when explicitly authorized", async () => {
    const { sessions, githubPrIdentity } = await createHarness();
    const session = await sessions.ensureSession("C888", "444.555");
    const service = new SlackCoauthorService({
      sessions,
      githubPrIdentity,
      slackApi: {
        getUserIdentity: vi.fn(async () => ({
          userId: "U1",
          mention: "<@U1>",
          realName: "Alice Example"
        })),
        postEphemeral: vi.fn(async () => "111.666"),
        openView: vi.fn(async () => {})
      } as never
    });

    const latestSession = await service.noteIncomingSlackInput(session, {
      source: "thread_reply",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "444.556",
      userId: "U1",
      senderKind: "user",
      text: "please commit this"
    });

    await service.handleInteractivePayload({
      type: "view_submission",
      user: { id: "U1" },
      view: {
        private_metadata: JSON.stringify({
          session_key: latestSession.key,
          candidate_revision: latestSession.coAuthorCandidateRevision
        }),
        state: {
          values: {
            contributors: {
              selected: {
                selected_options: [
                  { value: "U1" }
                ]
              }
            },
            commit_behavior: {
              selected: {
                selected_options: [
                  { value: "ignore_missing" }
                ]
              }
            }
          }
        }
      }
    });

    const resolved = await service.resolveCommitCoauthors({
      cwd: latestSession.workspacePath,
      commitMessage: "feat(slack): ignore unresolved"
    });
    expect(resolved.status).toBe("noop");
    expect(resolved.message).toContain("skipped for this commit");
  });

  it("rejects legacy configure-session GitHub author mappings", async () => {
    const { stateDir, sessions, githubPrIdentity } = await createHarness();
    const session = await sessions.ensureSession("C777", "222.333");
    const service = new SlackCoauthorService({
      sessions,
      githubPrIdentity,
      slackApi: {
        getUserIdentity: vi.fn(async (userId: string) => ({
          userId,
          mention: `<@${userId}>`,
          realName: userId === "U1" ? "Alice Example" : "Bob Example"
        })),
        postEphemeral: vi.fn(),
        openView: vi.fn()
      } as never
    });

    await service.noteIncomingSlackInput(session, {
      source: "thread_reply",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "222.334",
      userId: "U1",
      senderKind: "user",
      text: "first contributor"
    });

    await expect(service.configureSessionCoauthors({
      cwd: session.workspacePath,
      mappings: [
        {
          slackUser: "Alice Example",
          githubAuthor: "Alice Example <alice@example.com>"
        }
      ]
    })).rejects.toThrow("Manual co-author mappings are no longer supported. Bind GitHub OAuth for Slack users instead.");

    await expect(fs.readdir(path.join(stateDir, "github-author-mappings"))).rejects.toThrow();
  });

  async function createHarness(): Promise<{
    readonly stateDir: string;
    readonly sessions: SessionManager;
    readonly githubPrIdentity: GitHubPrIdentityService;
  }> {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-coauthor-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-coauthor-sessions-"));
    tempDirs.push(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore: new StateStore(stateDir, sessionsRoot),
      sessionsRoot
    });
    await sessions.load();
    const githubPrIdentity = new GitHubPrIdentityService({ stateDir });
    await githubPrIdentity.load();
    return {
      stateDir,
      sessions,
      githubPrIdentity
    };
  }
});
