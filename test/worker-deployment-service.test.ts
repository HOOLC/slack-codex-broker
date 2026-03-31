import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerDeploymentService } from "../src/services/deploy/worker-deployment-service.js";

describe("WorkerDeploymentService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("deploys git-backed releases and rolls back to the previous release", async () => {
    const serviceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "worker-deploy-"));
    tempDirs.push(serviceRoot);

    const repoRoot = path.join(serviceRoot, "repo");
    const releasesRoot = path.join(serviceRoot, "releases");
    const currentReleasePath = path.join(serviceRoot, "current");
    const previousReleasePath = path.join(serviceRoot, "previous");
    const failedReleasePath = path.join(serviceRoot, "failed");
    const workerPlistPath = path.join(serviceRoot, "worker.plist");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(releasesRoot, { recursive: true });
    await fs.writeFile(workerPlistPath, "<plist/>", "utf8");

    const refs = new Map([
      ["main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["previous", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
    ]);
    let launchdLoaded = false;

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true })
    })));
    vi.stubGlobal(
      "WebSocket",
      class FakeWebSocket {
        readonly #listeners = new Map<string, Array<() => void>>();

        constructor() {
          queueMicrotask(() => {
            for (const listener of this.#listeners.get("open") ?? []) {
              listener();
            }
          });
        }

        addEventListener(type: string, listener: () => void) {
          const existing = this.#listeners.get(type) ?? [];
          existing.push(listener);
          this.#listeners.set(type, existing);
        }

        close() {}
      }
    );

    const exec = vi.fn(async (command: string, args: readonly string[], options?: { readonly cwd?: string | undefined }) => {
      if (command === "git" && args[0] === "-C" && args[2] === "fetch") {
        return { stdout: "", stderr: "" };
      }

      if (command === "git" && args[0] === "-C" && args[2] === "remote") {
        return { stdout: "", stderr: "" };
      }

      if (command === "git" && args[0] === "-C" && args[2] === "rev-parse" && args[3] === "HEAD") {
        const cwd = String(args[1]);
        const revision = await fs.readFile(path.join(cwd, ".revision"), "utf8");
        return { stdout: revision, stderr: "" };
      }

      if (command === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        const ref = String(args[3]).replace(/\^\{commit\}$/, "");
        const revision = refs.get(ref);
        if (!revision) {
          throw new Error(`unknown ref ${ref}`);
        }
        return { stdout: `${revision}\n`, stderr: "" };
      }

      if (command === "git" && args[0] === "-C" && args[2] === "branch") {
        return { stdout: "main\n", stderr: "" };
      }

      if (command === "git" && args[0] === "-C" && args[2] === "worktree" && args[3] === "add") {
        const releaseRoot = String(args[5]);
        const revision = String(args[6]);
        await fs.mkdir(path.join(releaseRoot, ".git"), { recursive: true });
        await fs.writeFile(path.join(releaseRoot, ".revision"), `${revision}\n`, "utf8");
        return { stdout: "", stderr: "" };
      }

      if (command === "corepack") {
        return { stdout: "", stderr: "" };
      }

      if (command === "launchctl" && args[0] === "bootout") {
        launchdLoaded = false;
        return { stdout: "", stderr: "" };
      }

      if (command === "launchctl" && args[0] === "bootstrap") {
        launchdLoaded = true;
        return { stdout: "", stderr: "" };
      }

      if (command === "launchctl" && args[0] === "kickstart") {
        launchdLoaded = true;
        return { stdout: "", stderr: "" };
      }

      if (command === "launchctl" && args[0] === "print") {
        if (!launchdLoaded) {
          throw new Error("not loaded");
        }
        return { stdout: "loaded\n", stderr: "" };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const service = new WorkerDeploymentService({
      serviceRoot,
      repoRoot,
      releasesRoot,
      currentReleasePath,
      previousReleasePath,
      failedReleasePath,
      workerPlistPath,
      workerLaunchdLabel: "test.worker",
      workerBaseUrl: "http://127.0.0.1:3001",
      codexAppServerPort: 4590,
      releaseRepoUrl: "https://example.com/repo.git",
      exec
    });

    await service.deploy({ ref: "main" });
    const currentAfterFirstDeploy = path.resolve(path.dirname(currentReleasePath), await fs.readlink(currentReleasePath));
    expect(currentAfterFirstDeploy).toBe(path.join(releasesRoot, refs.get("main")!));
    await expect(fs.readlink(previousReleasePath)).rejects.toMatchObject({ code: "ENOENT" });

    await service.deploy({ ref: "previous" });
    const currentAfterSecondDeploy = path.resolve(path.dirname(currentReleasePath), await fs.readlink(currentReleasePath));
    const previousAfterSecondDeploy = path.resolve(path.dirname(previousReleasePath), await fs.readlink(previousReleasePath));
    expect(currentAfterSecondDeploy).toBe(path.join(releasesRoot, refs.get("previous")!));
    expect(previousAfterSecondDeploy).toBe(path.join(releasesRoot, refs.get("main")!));

    await service.rollback();
    const currentAfterRollback = path.resolve(path.dirname(currentReleasePath), await fs.readlink(currentReleasePath));
    const previousAfterRollback = path.resolve(path.dirname(previousReleasePath), await fs.readlink(previousReleasePath));
    expect(currentAfterRollback).toBe(path.join(releasesRoot, refs.get("main")!));
    expect(previousAfterRollback).toBe(path.join(releasesRoot, refs.get("previous")!));
  });
});
