import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  ReleaseDeploymentService
} from "../src/services/deploy/release-deployment-service.js";

const tempDirs: string[] = [];

describe("ReleaseDeploymentService", () => {
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

  it("uses a deploy health window large enough for slow Slack startup recovery", () => {
    expect(DEFAULT_HEALTH_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
  });

  it("deploys npm package releases without building source on the live host", async () => {
    const fixture = await createDeploymentFixture("worker-package-deploy-");
    const commands: string[] = [];
    let launchdLoaded = false;

    stubHealthyRuntime();
    const exec = createPackageExec({
      commands,
      versions: ["0.1.0", "0.2.0"],
      setLaunchdLoaded: (loaded) => {
        launchdLoaded = loaded;
      },
      isLaunchdLoaded: () => launchdLoaded
    });

    const service = new ReleaseDeploymentService({
      ...fixture.options,
      packageName: "agent-session-broker",
      exec
    });

    const firstStatus = await service.deploy({ version: "0.2.0" });
    expect(firstStatus.packageName).toBe("agent-session-broker");
    expect(firstStatus.recentPackageVersions[0]).toMatchObject({
      version: "0.2.0",
      packageSpec: "agent-session-broker@0.2.0"
    });
    const currentAfterFirstDeploy = path.resolve(path.dirname(fixture.currentReleasePath), await fs.readlink(fixture.currentReleasePath));
    expect(currentAfterFirstDeploy).toBe(packageRootFor(fixture.releasesRoot, "agent-session-broker", "0.2.0"));
    await expect(fs.readlink(fixture.previousReleasePath)).rejects.toMatchObject({ code: "ENOENT" });

    await service.deploy({ version: "0.1.0" });
    const currentAfterSecondDeploy = path.resolve(path.dirname(fixture.currentReleasePath), await fs.readlink(fixture.currentReleasePath));
    const previousAfterSecondDeploy = path.resolve(path.dirname(fixture.previousReleasePath), await fs.readlink(fixture.previousReleasePath));
    expect(currentAfterSecondDeploy).toBe(packageRootFor(fixture.releasesRoot, "agent-session-broker", "0.1.0"));
    expect(previousAfterSecondDeploy).toBe(packageRootFor(fixture.releasesRoot, "agent-session-broker", "0.2.0"));

    await service.rollback();
    const currentAfterRollback = path.resolve(path.dirname(fixture.currentReleasePath), await fs.readlink(fixture.currentReleasePath));
    const previousAfterRollback = path.resolve(path.dirname(fixture.previousReleasePath), await fs.readlink(fixture.previousReleasePath));
    expect(currentAfterRollback).toBe(packageRootFor(fixture.releasesRoot, "agent-session-broker", "0.2.0"));
    expect(previousAfterRollback).toBe(packageRootFor(fixture.releasesRoot, "agent-session-broker", "0.1.0"));

    expect(commands.some((command) => command.startsWith("git "))).toBe(false);
    expect(commands.some((command) => command.startsWith("corepack "))).toBe(false);
    expect(commands.some((command) => command.includes("pnpm"))).toBe(false);
    expect(commands.some((command) => command.includes(" build"))).toBe(false);
    expect(commands.some((command) => command.startsWith("npm install "))).toBe(true);
  });

  it("waits through transient worker health failures during package deploy", async () => {
    const fixture = await createDeploymentFixture("worker-package-health-");
    let launchdLoaded = false;
    let fetchCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls < 3) {
        return {
          ok: false,
          text: async () => "fetch failed"
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ ok: true })
      };
    }));
    stubOpenWebSocket();

    const exec = createPackageExec({
      commands: [],
      versions: ["0.3.0"],
      setLaunchdLoaded: (loaded) => {
        launchdLoaded = loaded;
      },
      isLaunchdLoaded: () => launchdLoaded
    });

    const service = new ReleaseDeploymentService({
      ...fixture.options,
      packageName: "agent-session-broker",
      healthCheckTimeoutMs: 50,
      healthCheckIntervalMs: 1,
      exec
    });

    await expect(service.deploy({ version: "0.3.0" })).resolves.toMatchObject({
      currentRelease: {
        metadata: {
          packageVersion: "0.3.0"
        }
      },
      worker: {
        healthOk: true,
        readyOk: true
      }
    });
    expect(fetchCalls).toBeGreaterThanOrEqual(3);
    await expect(fs.readlink(fixture.failedReleasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("schedules the admin launchd restart from the installed package current symlink", async () => {
    const fixture = await createDeploymentFixture("release-package-admin-");
    const adminPlistPath = path.join(fixture.serviceRoot, "admin.plist");
    await fs.writeFile(adminPlistPath, "<plist/>", "utf8");

    let workerLoaded = false;
    const scheduledAdminRestarts: Array<() => Promise<void>> = [];
    const detachedCommands: string[] = [];
    const commands: string[] = [];

    stubHealthyRuntime();
    const exec = createPackageExec({
      commands,
      versions: ["0.4.0"],
      setLaunchdLoaded: (loaded) => {
        workerLoaded = loaded;
      },
      isLaunchdLoaded: () => workerLoaded
    });

    const service = new ReleaseDeploymentService({
      ...fixture.options,
      adminPlistPath,
      adminLaunchdLabel: "test.admin",
      adminBaseUrl: "http://127.0.0.1:3000",
      packageName: "agent-session-broker",
      scheduleAdminRestart: (restart) => {
        scheduledAdminRestarts.push(restart);
      },
      spawnDetached: (command, args) => {
        detachedCommands.push(`${command} ${args.join(" ")}`);
      },
      exec
    });

    const status = await service.deploy({ version: "0.4.0" });
    expect(status.currentRelease.targetPath).toBe(packageRootFor(fixture.releasesRoot, "agent-session-broker", "0.4.0"));
    expect(status.worker.launchdLoaded).toBe(true);
    expect(scheduledAdminRestarts).toHaveLength(1);
    expect(commands.some((command) => command.includes(`${fixture.currentReleasePath}`))).toBe(false);

    await scheduledAdminRestarts[0]!();
    expect(commands.some((command) => command.includes(adminPlistPath))).toBe(false);
    expect(detachedCommands).toHaveLength(1);
    expect(detachedCommands[0]).toContain("macos-launchd-restart.mjs");
    expect(detachedCommands[0]).toContain("--plist " + adminPlistPath);
    expect(detachedCommands[0]).toContain("--label test.admin");
    expect(detachedCommands[0]).toContain("--domain gui/");
  });
});

async function createDeploymentFixture(prefix: string): Promise<{
  readonly serviceRoot: string;
  readonly releasesRoot: string;
  readonly currentReleasePath: string;
  readonly previousReleasePath: string;
  readonly failedReleasePath: string;
  readonly options: ConstructorParameters<typeof ReleaseDeploymentService>[0];
}> {
  const serviceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(serviceRoot);

  const releasesRoot = path.join(serviceRoot, "releases");
  const currentReleasePath = path.join(serviceRoot, "current");
  const previousReleasePath = path.join(serviceRoot, "previous");
  const failedReleasePath = path.join(serviceRoot, "failed");
  const workerPlistPath = path.join(serviceRoot, "worker.plist");
  await fs.mkdir(releasesRoot, { recursive: true });
  await fs.writeFile(workerPlistPath, "<plist/>", "utf8");

  return {
    serviceRoot,
    releasesRoot,
    currentReleasePath,
    previousReleasePath,
    failedReleasePath,
    options: {
      serviceRoot,
      releasesRoot,
      currentReleasePath,
      previousReleasePath,
      failedReleasePath,
      workerPlistPath,
      workerLaunchdLabel: "test.worker",
      workerBaseUrl: "http://127.0.0.1:3001",
      codexAppServerPort: 4590
    }
  };
}

function createPackageExec(options: {
  readonly commands: string[];
  readonly versions: readonly string[];
  readonly setLaunchdLoaded: (loaded: boolean) => void;
  readonly isLaunchdLoaded: () => boolean;
}) {
  return vi.fn(async (command: string, args: readonly string[]) => {
    options.commands.push(`${command} ${args.join(" ")}`);

    if (command === "npm" && args[0] === "view") {
      return { stdout: JSON.stringify(options.versions), stderr: "" };
    }

    if (command === "npm" && args[0] === "install") {
      const prefixIndex = args.indexOf("--prefix");
      const prefix = String(args[prefixIndex + 1]);
      const packageSpec = String(args[args.length - 1]);
      const version = packageSpec.slice(packageSpec.lastIndexOf("@") + 1);
      await writeInstalledPackage(prefix, "agent-session-broker", version);
      return { stdout: "", stderr: "" };
    }

    if (command === "launchctl" && args[0] === "bootout") {
      options.setLaunchdLoaded(false);
      return { stdout: "", stderr: "" };
    }

    if (command === "launchctl" && args[0] === "bootstrap") {
      options.setLaunchdLoaded(true);
      return { stdout: "", stderr: "" };
    }

    if (command === "launchctl" && args[0] === "kickstart") {
      options.setLaunchdLoaded(true);
      return { stdout: "", stderr: "" };
    }

    if (command === "launchctl" && args[0] === "print") {
      if (!options.isLaunchdLoaded()) {
        throw new Error("not loaded");
      }
      return { stdout: "loaded\n", stderr: "" };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
}

async function writeInstalledPackage(prefix: string, packageName: string, version: string): Promise<void> {
  const packageRoot = path.join(prefix, "node_modules", ...packageName.split("/"));
  await fs.mkdir(path.join(packageRoot, "dist", "src"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "scripts", "ops"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "dist", "src", "admin-index.js"), "", "utf8");
  await fs.writeFile(path.join(packageRoot, "dist", "src", "worker-index.js"), "", "utf8");
  await fs.writeFile(path.join(packageRoot, "scripts", "ops", "macos-launchd-launcher.mjs"), "", "utf8");
  await fs.writeFile(path.join(packageRoot, "scripts", "ops", "macos-launchd-restart.mjs"), "", "utf8");
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version
  }), "utf8");
}

function packageRootFor(releasesRoot: string, packageName: string, version: string): string {
  return path.join(releasesRoot, `npm-${version}`, "node_modules", ...packageName.split("/"));
}

function stubHealthyRuntime(): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify({ ok: true })
  })));
  stubOpenWebSocket();
}

function stubOpenWebSocket(): void {
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
}
