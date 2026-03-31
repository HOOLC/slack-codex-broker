import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { AuthProfileService } from "../src/services/auth-profile-service.js";

describe("AuthProfileService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          recursive: true,
          force: true
        })
      )
    );
  });

  it("bootstraps from the current auth file, adds profiles, activates, and deletes", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auth-profiles-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.writeFile(
      path.join(config.codexHome, "auth.json"),
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "seed-access",
            account_id: "seed-account"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const profileService = new AuthProfileService({
      config,
      probeProfile: async (profileName) => ({
        source: "probe",
        checkedAt: "2026-03-30T00:00:00.000Z",
        account: {
          ok: true,
          account: {
            email: `${profileName}@example.com`,
            type: "chatgpt",
            planType: "pro"
          },
          requiresOpenaiAuth: false
        },
        rateLimits: {
          ok: true,
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: 1_743_307_200
            },
            secondary: {
              usedPercent: 20,
              windowDurationMins: 10_080,
              resetsAt: 1_743_912_000
            },
            credits: null,
            planType: "pro"
          },
          rateLimitsByLimitId: {}
        }
      })
    });

    const initialStatus = await profileService.listProfilesStatus();
    expect(initialStatus.activeProfile).toBe("primary");
    expect(initialStatus.profiles).toHaveLength(1);
    expect(initialStatus.profiles[0]?.name).toBe("primary");
    expect(initialStatus.profiles[0]?.active).toBe(true);

    const addedProfile = await profileService.addProfile({
      authJsonContent: JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "backup-access",
          account_id: "backup-account"
        }
      })
    });
    expect(addedProfile.name).toBe("backup-account");

    const duplicateProfile = await profileService.addProfile({
      authJsonContent: JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "backup-access-2",
          account_id: "backup-account"
        }
      })
    });
    expect(duplicateProfile.name).toBe("backup-account-2");

    const afterAdd = await profileService.listProfilesStatus();
    expect(afterAdd.profiles.map((profile) => profile.name).sort()).toEqual(["backup-account", "backup-account-2", "primary"]);

    await profileService.activateProfile("backup-account");
    const activeLinkTarget = await fs.readlink(path.join(config.codexHome, "auth.json"));
    expect(activeLinkTarget).toContain(path.join("..", "auth-profiles", "docker", "active.json"));

    const afterActivate = await profileService.listProfilesStatus();
    expect(afterActivate.activeProfile).toBe("backup-account");
    expect(afterActivate.profiles.find((profile) => profile.name === "backup-account")?.active).toBe(true);

    await expect(profileService.deleteProfile("backup-account")).rejects.toThrow("Cannot delete the active auth profile");
    await profileService.activateProfile("primary");
    await profileService.deleteProfile("backup-account");
    await profileService.deleteProfile("backup-account-2");

    const afterDelete = await profileService.listProfilesStatus();
    expect(afterDelete.profiles.map((profile) => profile.name).sort()).toEqual(["primary"]);
  });

  it("supports an empty bootstrap and activates the first imported profile", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auth-profiles-empty-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });

    const profileService = new AuthProfileService({
      config,
      probeProfile: async (profileName) => ({
        source: "probe",
        checkedAt: "2026-03-31T00:00:00.000Z",
        account: {
          ok: true,
          account: {
            email: `${profileName}@example.com`,
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        },
        rateLimits: {
          ok: true,
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            planType: "team"
          },
          rateLimitsByLimitId: {}
        }
      })
    });

    const initialStatus = await profileService.listProfilesStatus();
    expect(initialStatus.activeProfile).toBeNull();
    expect(initialStatus.profiles).toEqual([]);

    const addedProfile = await profileService.addProfile({
      authJsonContent: JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "first-access",
          account_id: "first-account"
        }
      })
    });

    expect(addedProfile.active).toBe(true);

    const afterAdd = await profileService.listProfilesStatus();
    expect(afterAdd.activeProfile).toBe("first-account");
    expect(afterAdd.profiles).toHaveLength(1);
    expect(afterAdd.profiles[0]?.active).toBe(true);
  });
});
