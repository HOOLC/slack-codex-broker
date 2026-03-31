import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { AdminService } from "../src/services/admin-service.js";

describe("AdminService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("includes account rate limits in status output", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker.jsonl"), "", "utf8");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: "primary",
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "quota@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_735_692_000
            },
            secondary: {
              usedPercent: 7,
              windowDurationMins: 10_080,
              resetsAt: 1_735_999_999
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: "18.75"
            },
            planType: "team"
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_735_692_000
              },
              secondary: {
                usedPercent: 7,
                windowDurationMins: 10_080,
                resetsAt: 1_735_999_999
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: "18.75"
              },
              planType: "team"
            }
          }
        })
      } as never
    });

    const status = await service.getStatus();
    expect(status).toMatchObject({
      account: {
        ok: true,
        account: {
          email: "quota@example.com",
          type: "chatgpt",
          planType: "team"
        }
      },
      rateLimits: {
        ok: true,
        rateLimits: {
          limitId: "codex",
          planType: "team",
          credits: {
            balance: "18.75",
            hasCredits: true,
            unlimited: false
          }
        },
        rateLimitsByLimitId: {
          codex: {
            limitName: "Codex"
          }
        }
      },
      authProfiles: {
        activeProfile: "primary",
        profiles: []
      }
    });
  });
});
