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

  it("deploys split npm package releases without building source on the live host", async () => {
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
      packages: {
        admin: "@agent-session-broker/admin",
        worker: "@agent-session-broker/worker"
      },
      exec
    });

    const workerStatus = await service.deploy({ target: "worker", version: "0.2.0" });
    expect(workerStatus.targets.worker.packageName).toBe("@agent-session-broker/worker");
    expect(workerStatus.targets.worker.recentPackageVersions[0]).toMatchObject({
      version: "0.2.0",
      packageSpec: "@agent-session-broker/worker@0.2.0"
    });
    const currentWorkerAfterDeploy = path.resolve(
      path.dirname(fixture.currentWorkerReleasePath),
      await fs.readlink(fixture.currentWorkerReleasePath)
    );
    expect(currentWorkerAfterDeploy).toBe(packageRootFor(
      fixture.releasesRoot,
      "worker",
      "@agent-session-broker/worker",
      "0.2.0"
    ));
    await expect(fs.readlink(fixture.currentAdminReleasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(fixture.previousWorkerReleasePath)).rejects.toMatchObject({ code: "ENOENT" });

    await service.deploy({ target: "worker", version: "0.1.0" });
    const currentAfterSecondDeploy = path.resolve(
      path.dirname(fixture.currentWorkerReleasePath),
      await fs.readlink(fixture.currentWorkerReleasePath)
    );
    const previousAfterSecondDeploy = path.resolve(
      path.dirname(fixture.previousWorkerReleasePath),
      await fs.readlink(fixture.previousWorkerReleasePath)
    );
    expect(currentAfterSecondDeploy).toBe(packageRootFor(
      fixture.releasesRoot,
      "worker",
      "@agent-session-broker/worker",
      "0.1.0"
    ));
    expect(previousAfterSecondDeploy).toBe(packageRootFor(
      fixture.releasesRoot,
      "worker",
      "@agent-session-broker/worker",
      "0.2.0"
    ));

    await service.rollback({ target: "worker" });
    const currentAfterRollback = path.resolve(
      path.dirname(fixture.currentWorkerReleasePath),
      await fs.readlink(fixture.currentWorkerReleasePath)
    );
    const previousAfterRollback = path.resolve(
      path.dirname(fixture.previousWorkerReleasePath),
      await fs.readlink(fixture.previousWorkerReleasePath)
    );
    expect(currentAfterRollback).toBe(packageRootFor(
      fixture.releasesRoot,
      "worker",
      "@agent-session-broker/worker",
      "0.2.0"
    ));
    expect(previousAfterRollback).toBe(packageRootFor(
      fixture.releasesRoot,
      "worker",
      "@agent-session-broker/worker",
      "0.1.0"
    ));

    expect(commands.some((command) => command.startsWith("git "))).toBe(false);
    expect(commands.some((command) => command.startsWith("corepack "))).toBe(false);
    expect(commands.some((command) => command.includes("pnpm"))).toBe(false);
    expect(commands.some((command) => command.includes(" build"))).toBe(false);
    expect(commands.some((command) => command.startsWith("npm install "))).toBe(true);
    expect(commands.some((command) => command.includes("@agent-session-broker/worker@0.2.0"))).toBe(true);
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
      packages: {
        admin: "@agent-session-broker/admin",
        worker: "@agent-session-broker/worker"
      },
      healthCheckTimeoutMs: 50,
      healthCheckIntervalMs: 1,
      exec
    });

    await expect(service.deploy({ target: "worker", version: "0.3.0" })).resolves.toMatchObject({
      targets: {
        worker: {
          currentRelease: {
            metadata: {
              packageVersion: "0.3.0"
            }
          }
        }
      },
      worker: {
        healthOk: true,
        readyOk: true
      }
    });
    expect(fetchCalls).toBeGreaterThanOrEqual(3);
    await expect(fs.readlink(fixture.failedWorkerReleasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deploys admin releases without restarting worker", async () => {
    const fixture = await createDeploymentFixture("release-package-admin-only-");
    const commands: string[] = [];
    let launchdLoaded = false;
    const scheduledAdminRestarts: Array<() => Promise<void>> = [];

    stubHealthyRuntime();
    const exec = createPackageExec({
      commands,
      versions: ["0.5.0"],
      setLaunchdLoaded: (loaded) => {
        launchdLoaded = loaded;
      },
      isLaunchdLoaded: () => launchdLoaded
    });

    const service = new ReleaseDeploymentService({
      ...fixture.options,
      packages: {
        admin: "@agent-session-broker/admin",
        worker: "@agent-session-broker/worker"
      },
      scheduleAdminRestart: (restart) => {
        scheduledAdminRestarts.push(restart);
      },
      exec
    });

    const status = await service.deploy({ target: "admin", version: "0.5.0" });
    expect(status.targets.admin.currentRelease.targetPath).toBe(packageRootFor(
      fixture.releasesRoot,
      "admin",
      "@agent-session-broker/admin",
      "0.5.0"
    ));
    expect(status.targets.worker.currentRelease.targetPath).toBeNull();
    expect(scheduledAdminRestarts).toHaveLength(1);
    expect(commands.some((command) => command.includes(fixture.workerPlistPath))).toBe(false);
  });

  it("schedules the admin launchd restart from the installed admin package current symlink", async () => {
    const fixture = await createDeploymentFixture("release-package-admin-");
    const scheduledAdminRestarts: Array<() => Promise<void>> = [];
    const detachedCommands: string[] = [];
    const commands: string[] = [];
    let launchdLoaded = false;

    stubHealthyRuntime();
    const exec = createPackageExec({
      commands,
      versions: ["0.4.0"],
      setLaunchdLoaded: (loaded) => {
        launchdLoaded = loaded;
      },
      isLaunchdLoaded: () => launchdLoaded
    });

    const service = new ReleaseDeploymentService({
      ...fixture.options,
      packages: {
        admin: "@agent-session-broker/admin",
        worker: "@agent-session-broker/worker"
      },
      scheduleAdminRestart: (restart) => {
        scheduledAdminRestarts.push(restart);
      },
      spawnDetached: (command, args) => {
        detachedCommands.push(`${command} ${args.join(" ")}`);
      },
      exec
    });

    const status = await service.deploy({ target: "admin", version: "0.4.0" });
    expect(status.targets.admin.currentRelease.targetPath).toBe(packageRootFor(
      fixture.releasesRoot,
      "admin",
      "@agent-session-broker/admin",
      "0.4.0"
    ));
    expect(scheduledAdminRestarts).toHaveLength(1);
    expect(commands.some((command) => command.includes(`${fixture.currentAdminReleasePath}`))).toBe(false);

    await scheduledAdminRestarts[0]!();
    expect(commands.some((command) => command.includes(fixture.adminPlistPath))).toBe(false);
    expect(detachedCommands).toHaveLength(1);
    expect(detachedCommands[0]).toContain("macos-launchd-restart.mjs");
    expect(detachedCommands[0]).toContain("--plist " + fixture.adminPlistPath);
    expect(detachedCommands[0]).toContain("--label test.admin");
    expect(detachedCommands[0]).toContain("--domain system");
    expect(detachedCommands[0]).not.toContain("--domain gui/");
  });

  it("restarts worker releases through the system launchd domain", async () => {
    const fixture = await createDeploymentFixture("release-package-system-launchd-");
    const commands: string[] = [];
    let launchdLoaded = false;

    stubHealthyRuntime();
    const exec = createPackageExec({
      commands,
      versions: ["0.6.0"],
      setLaunchdLoaded: (loaded) => {
        launchdLoaded = loaded;
      },
      isLaunchdLoaded: () => launchdLoaded
    });

    const service = new ReleaseDeploymentService({
      ...fixture.options,
      packages: {
        admin: "@agent-session-broker/admin",
        worker: "@agent-session-broker/worker"
      },
      exec
    });

    await service.deploy({ target: "worker", version: "0.6.0" });
    expect(commands).toContain(`launchctl bootout system ${fixture.workerPlistPath}`);
    expect(commands).toContain(`launchctl bootstrap system ${fixture.workerPlistPath}`);
    expect(commands).toContain("launchctl kickstart -k system/test.worker");
    expect(commands).toContain("launchctl print system/test.worker");
    expect(commands.some((command) => command.includes("gui/"))).toBe(false);
  });

  it("keeps legacy single-package deploy options out of the service contract", async () => {
    const serviceSource = await fs.readFile(
      new URL("../src/services/deploy/release-deployment-service.ts", import.meta.url),
      "utf8"
    );
    expect(serviceSource).toContain("readonly target: ReleaseTarget");
    expect(serviceSource).not.toContain("readonly packageName?: string");
    expect(serviceSource).not.toContain("DEFAULT_RELEASE_PACKAGE_NAME");
  });
});

async function createDeploymentFixture(prefix: string): Promise<{
  readonly serviceRoot: string;
  readonly releasesRoot: string;
  readonly currentAdminReleasePath: string;
  readonly previousAdminReleasePath: string;
  readonly failedAdminReleasePath: string;
  readonly currentWorkerReleasePath: string;
  readonly previousWorkerReleasePath: string;
  readonly failedWorkerReleasePath: string;
  readonly adminPlistPath: string;
  readonly workerPlistPath: string;
  readonly options: ConstructorParameters<typeof ReleaseDeploymentService>[0];
}> {
  const serviceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(serviceRoot);

  const releasesRoot = path.join(serviceRoot, "releases");
  const currentAdminReleasePath = path.join(serviceRoot, "current-admin");
  const previousAdminReleasePath = path.join(serviceRoot, "previous-admin");
  const failedAdminReleasePath = path.join(serviceRoot, "failed-admin");
  const currentWorkerReleasePath = path.join(serviceRoot, "current-worker");
  const previousWorkerReleasePath = path.join(serviceRoot, "previous-worker");
  const failedWorkerReleasePath = path.join(serviceRoot, "failed-worker");
  const adminPlistPath = path.join(serviceRoot, "admin.plist");
  const workerPlistPath = path.join(serviceRoot, "worker.plist");
  await fs.mkdir(releasesRoot, { recursive: true });
  await fs.writeFile(adminPlistPath, "<plist/>", "utf8");
  await fs.writeFile(workerPlistPath, "<plist/>", "utf8");

  return {
    serviceRoot,
    releasesRoot,
    currentAdminReleasePath,
    previousAdminReleasePath,
    failedAdminReleasePath,
    currentWorkerReleasePath,
    previousWorkerReleasePath,
    failedWorkerReleasePath,
    adminPlistPath,
    workerPlistPath,
    options: {
      serviceRoot,
      releasesRoot,
      currentAdminReleasePath,
      previousAdminReleasePath,
      failedAdminReleasePath,
      currentWorkerReleasePath,
      previousWorkerReleasePath,
      failedWorkerReleasePath,
      adminPlistPath,
      adminLaunchdLabel: "test.admin",
      adminBaseUrl: "http://127.0.0.1:3000",
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
      const parsed = parsePackageSpec(String(args[args.length - 1]));
      await writeInstalledPackage(prefix, parsed.packageName, parsed.version);
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
  if (packageName.endsWith("/admin")) {
    await fs.mkdir(path.join(packageRoot, "dist", "admin-ui"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "dist", "src", "admin-index.js"), "", "utf8");
    await fs.writeFile(path.join(packageRoot, "dist", "admin-ui", "index.html"), "", "utf8");
    await fs.writeFile(path.join(packageRoot, "scripts", "ops", "macos-bootstrap.mjs"), "", "utf8");
  }
  if (packageName.endsWith("/worker")) {
    await fs.writeFile(path.join(packageRoot, "dist", "src", "worker-index.js"), "", "utf8");
  }
  await fs.writeFile(path.join(packageRoot, "scripts", "ops", "macos-launchd-launcher.mjs"), "", "utf8");
  await fs.writeFile(path.join(packageRoot, "scripts", "ops", "macos-launchd-restart.mjs"), "", "utf8");
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version
  }), "utf8");
}

function packageRootFor(releasesRoot: string, target: string, packageName: string, version: string): string {
  return path.join(releasesRoot, target, `npm-${version}`, "node_modules", ...packageName.split("/"));
}

function parsePackageSpec(spec: string): { readonly packageName: string; readonly version: string } {
  const versionSeparator = spec.lastIndexOf("@");
  return {
    packageName: spec.slice(0, versionSeparator),
    version: spec.slice(versionSeparator + 1)
  };
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
