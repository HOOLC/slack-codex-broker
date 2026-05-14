import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../logger.js";
import { execCommand, spawnDetachedCommand } from "../../utils/exec.js";
import { ensureDir, fileExists } from "../../utils/fs.js";

const RELEASE_METADATA_FILENAME = ".broker-release.json";
const RELEASE_STATE_SCHEMA_VERSION = 3;
const DEFAULT_RELEASE_PACKAGES: Record<ReleaseTarget, string> = {
  admin: "@agent-session-broker/admin",
  worker: "@agent-session-broker/worker"
};
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 90_000;

export type ReleaseTarget = "admin" | "worker";

export interface ReleaseMetadata {
  readonly revision: string | null;
  readonly shortRevision: string | null;
  readonly branch: string | null;
  readonly target: ReleaseTarget;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageSpec: string;
  readonly installedAt: string;
  readonly installedBy: string;
  readonly installedFromHost: string;
  readonly requestedVersion: string;
  readonly builtAt?: string | undefined;
  readonly builtBy?: string | undefined;
  readonly builtFromHost?: string | undefined;
  readonly requestedRef?: string | null | undefined;
  readonly stateSchemaVersion: number;
}

export interface ReleaseInfo {
  readonly linkPath: string;
  readonly targetPath: string | null;
  readonly exists: boolean;
  readonly metadata: ReleaseMetadata | null;
}

export interface ReleasePackageVersionInfo {
  readonly version: string;
  readonly packageSpec: string;
}

export interface ReleaseTargetStatus {
  readonly target: ReleaseTarget;
  readonly packageName: string;
  readonly currentRelease: ReleaseInfo;
  readonly previousRelease: ReleaseInfo;
  readonly failedRelease: ReleaseInfo;
  readonly recentReleases: readonly ReleaseInfo[];
  readonly recentPackageVersions: readonly ReleasePackageVersionInfo[];
}

export interface WorkerHealthStatus {
  readonly launchdLoaded: boolean;
  readonly healthOk: boolean;
  readonly readyOk: boolean;
  readonly healthBody: string;
  readonly readyError: string | null;
}

export interface AdminHealthStatus {
  readonly launchdLoaded: boolean;
  readonly healthOk: boolean;
  readonly healthBody: string;
}

export interface ReleaseDeploymentStatus {
  readonly serviceRoot: string;
  readonly npmRegistryUrl: string | null;
  readonly targets: Record<ReleaseTarget, ReleaseTargetStatus>;
  readonly admin: AdminHealthStatus | null;
  readonly worker: WorkerHealthStatus;
}

export interface DeployReleaseOptions {
  readonly target: ReleaseTarget;
  readonly version: string;
}

export interface RollbackReleaseOptions {
  readonly target: ReleaseTarget;
  readonly version?: string | undefined;
}

interface ReleaseTargetPaths {
  readonly currentReleasePath: string;
  readonly previousReleasePath: string;
  readonly failedReleasePath: string;
}

export class ReleaseDeploymentService {
  readonly #uid = typeof process.getuid === "function" ? process.getuid() : 0;
  #operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly serviceRoot: string;
      readonly releasesRoot: string;
      readonly currentAdminReleasePath: string;
      readonly previousAdminReleasePath: string;
      readonly failedAdminReleasePath: string;
      readonly currentWorkerReleasePath: string;
      readonly previousWorkerReleasePath: string;
      readonly failedWorkerReleasePath: string;
      readonly adminPlistPath?: string | undefined;
      readonly adminLaunchdLabel?: string | undefined;
      readonly adminBaseUrl?: string | undefined;
      readonly workerPlistPath: string;
      readonly workerLaunchdLabel: string;
      readonly workerBaseUrl: string;
      readonly codexAppServerPort: number;
      readonly packages?: Partial<Record<ReleaseTarget, string>> | undefined;
      readonly npmPath?: string | undefined;
      readonly npmRegistryUrl?: string | undefined;
      readonly healthCheckTimeoutMs?: number | undefined;
      readonly healthCheckIntervalMs?: number | undefined;
      readonly scheduleAdminRestart?: ((restart: () => Promise<void>) => void) | undefined;
      readonly exec?: typeof execCommand | undefined;
      readonly spawnDetached?: typeof spawnDetachedCommand | undefined;
    }
  ) {}

  async getStatus(): Promise<ReleaseDeploymentStatus> {
    const [adminTarget, workerTarget, admin, worker] = await Promise.all([
      this.#readTargetStatus("admin"),
      this.#readTargetStatus("worker"),
      this.#readAdminHealth(),
      this.#readWorkerHealth()
    ]);

    return {
      serviceRoot: this.options.serviceRoot,
      npmRegistryUrl: this.options.npmRegistryUrl ?? null,
      targets: {
        admin: adminTarget,
        worker: workerTarget
      },
      admin,
      worker
    };
  }

  async deploy(options: DeployReleaseOptions): Promise<ReleaseDeploymentStatus> {
    return await this.#runExclusive(async () => {
      const target = normalizeReleaseTarget(options.target);
      const version = normalizePackageVersion(options.version);
      const releaseRoot = await this.#ensurePackageRelease(target, version);
      const metadata = this.#buildReleaseMetadata(target, version);
      await this.#writeReleaseMetadata(releaseRoot, metadata);
      await this.#activateRelease(target, releaseRoot);
      return await this.getStatus();
    });
  }

  async rollback(options: RollbackReleaseOptions): Promise<ReleaseDeploymentStatus> {
    return await this.#runExclusive(async () => {
      const target = normalizeReleaseTarget(options.target);
      const releaseRoot = options.version
        ? await this.#requireInstalledPackageRelease(target, options.version)
        : await this.#requirePreviousRelease(target);
      await this.#activateRelease(target, releaseRoot);
      return await this.getStatus();
    });
  }

  async restartWorker(reason: string): Promise<void> {
    await this.#runExclusive(async () => {
      await this.#restartLaunchdWorker(reason);
      await this.#assertWorkerHealthy();
    });
  }

  async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationQueue;
    let releaseQueue = () => {};
    this.#operationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      releaseQueue();
    }
  }

  async #readTargetStatus(target: ReleaseTarget): Promise<ReleaseTargetStatus> {
    const paths = this.#targetPaths(target);
    const [currentRelease, previousRelease, failedRelease, recentReleases, recentPackageVersions] = await Promise.all([
      this.#readLinkedRelease(paths.currentReleasePath),
      this.#readLinkedRelease(paths.previousReleasePath),
      this.#readLinkedRelease(paths.failedReleasePath),
      this.#readRecentReleases(target),
      this.#readRecentPackageVersions(target)
    ]);

    return {
      target,
      packageName: this.#packageName(target),
      currentRelease,
      previousRelease,
      failedRelease,
      recentReleases,
      recentPackageVersions
    };
  }

  async #ensurePackageRelease(target: ReleaseTarget, version: string): Promise<string> {
    const installRoot = this.#installRootForVersion(target, version);
    const packageRoot = this.#packageRootForInstallRoot(target, installRoot);
    if (await this.#isUsablePackageRoot(target, packageRoot)) {
      return packageRoot;
    }

    await ensureDir(path.dirname(installRoot));
    const tempRoot = `${installRoot}.tmp-${process.pid}-${Date.now()}`;
    await fs.rm(tempRoot, { force: true, recursive: true });

    try {
      await this.#exec(this.#npmPath(), [
        "install",
        "--prefix",
        tempRoot,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...this.#npmRegistryArgs(),
        packageSpec(this.#packageName(target), version)
      ]);
      const tempPackageRoot = this.#packageRootForInstallRoot(target, tempRoot);
      await this.#assertUsablePackageRoot(target, tempPackageRoot);
      await fs.rm(installRoot, { force: true, recursive: true });
      await fs.rename(tempRoot, installRoot);
      return packageRoot;
    } catch (error) {
      await fs.rm(tempRoot, { force: true, recursive: true });
      throw error;
    }
  }

  async #requireInstalledPackageRelease(target: ReleaseTarget, version: string): Promise<string> {
    const normalized = normalizePackageVersion(version);
    const packageRoot = this.#packageRootForInstallRoot(target, this.#installRootForVersion(target, normalized));
    if (!(await this.#isUsablePackageRoot(target, packageRoot))) {
      throw new Error(`Package release is not installed locally: ${this.#packageName(target)}@${normalized}`);
    }
    return packageRoot;
  }

  async #requirePreviousRelease(target: ReleaseTarget): Promise<string> {
    const previous = await this.#readLinkedRelease(this.#targetPaths(target).previousReleasePath);
    if (!previous.targetPath || !(await fileExists(previous.targetPath))) {
      throw new Error(`No previous ${target} release found at ${previous.linkPath}`);
    }
    return previous.targetPath;
  }

  #buildReleaseMetadata(target: ReleaseTarget, version: string): ReleaseMetadata {
    const packageName = this.#packageName(target);
    return {
      revision: null,
      shortRevision: null,
      branch: null,
      target,
      packageName,
      packageVersion: version,
      packageSpec: packageSpec(packageName, version),
      requestedVersion: version,
      installedAt: new Date().toISOString(),
      installedBy: process.env.USER || process.env.LOGNAME || "unknown",
      installedFromHost: process.env.HOSTNAME || "unknown",
      stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION
    };
  }

  async #writeReleaseMetadata(releaseRoot: string, metadata: ReleaseMetadata): Promise<void> {
    await fs.writeFile(
      path.join(releaseRoot, RELEASE_METADATA_FILENAME),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );
  }

  async #activateRelease(target: ReleaseTarget, releaseRoot: string): Promise<void> {
    const paths = this.#targetPaths(target);
    const currentRelease = await this.#readLinkedRelease(paths.currentReleasePath);
    const previousRelease = await this.#readLinkedRelease(paths.previousReleasePath);
    const previousCurrentPath = currentRelease.targetPath;
    const previousPreviousPath = previousRelease.targetPath;

    await this.#pointLink(paths.currentReleasePath, releaseRoot);
    if (previousCurrentPath && previousCurrentPath !== releaseRoot) {
      await this.#pointLink(paths.previousReleasePath, previousCurrentPath);
    }

    try {
      if (target === "worker") {
        await this.#restartLaunchdWorker("worker release activation");
        await this.#assertWorkerHealthy();
      } else {
        this.#scheduleAdminRestart("admin release activation");
      }
      await fs.rm(paths.failedReleasePath, { force: true, recursive: true });
    } catch (error) {
      await this.#pointLink(paths.failedReleasePath, releaseRoot);
      if (previousCurrentPath) {
        await this.#pointLink(paths.currentReleasePath, previousCurrentPath);
      } else {
        await fs.rm(paths.currentReleasePath, { force: true, recursive: true });
      }

      if (previousPreviousPath && previousPreviousPath !== releaseRoot) {
        await this.#pointLink(paths.previousReleasePath, previousPreviousPath);
      } else if (!previousCurrentPath || previousCurrentPath === releaseRoot) {
        await fs.rm(paths.previousReleasePath, { force: true, recursive: true });
      }

      if (target === "worker" && previousCurrentPath) {
        await this.#restartLaunchdWorker("worker release rollback");
      }

      throw error;
    }
  }

  async #restartLaunchdWorker(reason: string): Promise<void> {
    await this.#restartLaunchdService({
      reason,
      plistPath: this.options.workerPlistPath,
      launchdLabel: this.options.workerLaunchdLabel,
      serviceName: "worker"
    });
  }

  async #restartLaunchdAdmin(reason: string): Promise<void> {
    if (!this.options.adminPlistPath || !this.options.adminLaunchdLabel) {
      return;
    }

    await this.#spawnDetachedAdminRestart(reason);
  }

  async #spawnDetachedAdminRestart(reason: string): Promise<void> {
    if (!this.options.adminPlistPath || !this.options.adminLaunchdLabel) {
      return;
    }

    if (!(await fileExists(this.options.adminPlistPath))) {
      throw new Error(`Missing admin launchd plist: ${this.options.adminPlistPath}`);
    }

    const restartScriptPath = path.join(
      this.options.currentAdminReleasePath,
      "scripts",
      "ops",
      "macos-launchd-restart.mjs"
    );
    if (!(await fileExists(restartScriptPath))) {
      throw new Error(`Missing admin launchd restart helper: ${restartScriptPath}`);
    }

    const domain = `gui/${this.#uid}`;
    const restartLogPath = path.join(this.options.serviceRoot, "logs", "admin-restart.log");
    await ensureDir(path.dirname(restartLogPath));
    this.#spawnDetached(process.execPath, [
      restartScriptPath,
      "--domain",
      domain,
      "--plist",
      this.options.adminPlistPath,
      "--label",
      this.options.adminLaunchdLabel,
      "--delay-ms",
      "250",
      "--log-file",
      restartLogPath,
      "--reason",
      reason
    ], {
      cwd: this.options.serviceRoot
    });

    logger.info("Scheduled detached admin launchd restart", {
      reason,
      domain,
      launchdLabel: this.options.adminLaunchdLabel,
      plistPath: this.options.adminPlistPath,
      helper: restartScriptPath
    });
  }

  async #restartLaunchdService(options: {
    readonly reason: string;
    readonly plistPath: string;
    readonly launchdLabel: string;
    readonly serviceName: string;
  }): Promise<void> {
    if (!(await fileExists(options.plistPath))) {
      throw new Error(`Missing ${options.serviceName} launchd plist: ${options.plistPath}`);
    }

    const domain = `gui/${this.#uid}`;
    await this.#exec("launchctl", ["bootout", domain, options.plistPath]).catch(() => undefined);
    await this.#exec("launchctl", ["bootstrap", domain, options.plistPath]);
    await this.#exec("launchctl", ["kickstart", "-k", `${domain}/${options.launchdLabel}`]);
  }

  async #assertWorkerHealthy(): Promise<void> {
    const timeoutMs = this.options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
    const intervalMs = this.options.healthCheckIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastStatus = await this.#readWorkerHealth();

    while (Date.now() < deadline) {
      if (lastStatus.launchdLoaded && lastStatus.healthOk && lastStatus.readyOk) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      lastStatus = await this.#readWorkerHealth();
    }

    if (!lastStatus.launchdLoaded || !lastStatus.healthOk || !lastStatus.readyOk) {
      throw new Error(
        `Worker failed health checks: launchdLoaded=${lastStatus.launchdLoaded} healthOk=${lastStatus.healthOk} readyOk=${lastStatus.readyOk}${lastStatus.readyError ? ` readyError=${lastStatus.readyError}` : ""}`
      );
    }
  }

  async #readWorkerHealth(): Promise<WorkerHealthStatus> {
    const launchdLoaded = await this.#isLaunchdLoaded(this.options.workerLaunchdLabel);
    const healthResponse = await this.#fetchText(`${this.options.workerBaseUrl}/readyz`);
    const healthOk = Boolean(healthResponse.ok && healthResponse.body.includes("\"ok\":true"));
    const ready = await this.#checkWsReady();
    return {
      launchdLoaded,
      healthOk,
      readyOk: ready.ok,
      healthBody: healthResponse.body,
      readyError: ready.ok ? null : ready.error
    };
  }

  async #readAdminHealth(): Promise<AdminHealthStatus | null> {
    if (!this.options.adminLaunchdLabel || !this.options.adminBaseUrl) {
      return null;
    }

    const launchdLoaded = await this.#isLaunchdLoaded(this.options.adminLaunchdLabel);
    const healthResponse = await this.#fetchText(`${this.options.adminBaseUrl}/readyz`);
    return {
      launchdLoaded,
      healthOk: Boolean(healthResponse.ok && healthResponse.body.includes("\"ok\":true")),
      healthBody: healthResponse.body
    };
  }

  #scheduleAdminRestart(reason: string): void {
    if (!this.options.adminPlistPath || !this.options.adminLaunchdLabel) {
      return;
    }

    const restart = async () => {
      await this.#restartLaunchdAdmin(reason);
    };

    if (this.options.scheduleAdminRestart) {
      this.options.scheduleAdminRestart(restart);
      return;
    }

    const timer = setTimeout(() => {
      void restart().catch((error) => {
        logger.error("Scheduled admin restart failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 250);
    timer.unref?.();
  }

  async #isLaunchdLoaded(label: string): Promise<boolean> {
    const domain = `gui/${this.#uid}/${label}`;
    try {
      await this.#exec("launchctl", ["print", domain]);
      return true;
    } catch {
      return false;
    }
  }

  async #fetchText(url: string): Promise<{ readonly ok: boolean; readonly body: string }> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3_000)
      });
      const body = await response.text();
      return {
        ok: response.ok,
        body
      };
    } catch (error) {
      return {
        ok: false,
        body: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async #checkWsReady(): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          error: "timeout"
        });
      }, 3_000);

      let socket: WebSocket;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${this.options.codexAppServerPort}`);
      } catch (error) {
        clearTimeout(timer);
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }

      const finish = (result: { readonly ok: true } | { readonly ok: false; readonly error: string }) => {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore close failures.
        }
        resolve(result);
      };

      socket.addEventListener("open", () => {
        finish({ ok: true });
      });
      socket.addEventListener("error", (event) => {
        const error = "error" in event && event.error instanceof Error ? event.error.message : "websocket_open_failed";
        finish({
          ok: false,
          error
        });
      });
    });
  }

  async #readRecentReleases(target: ReleaseTarget): Promise<readonly ReleaseInfo[]> {
    const targetReleaseRoot = path.join(this.options.releasesRoot, target);
    if (!(await fileExists(targetReleaseRoot))) {
      return [];
    }

    const entries = await fs.readdir(targetReleaseRoot, { withFileTypes: true });
    const releases = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const installRoot = path.join(targetReleaseRoot, entry.name);
          const targetPath = await this.#resolveReleaseRootFromInstallEntry(target, installRoot);
          if (!targetPath) {
            return null;
          }
          const metadata = await this.#readReleaseMetadata(targetPath);
          const stat = await fs.stat(targetPath);
          return {
            linkPath: targetPath,
            targetPath,
            exists: true,
            metadata,
            mtimeMs: stat.mtimeMs
          };
        })
    );

    return releases
      .filter((release): release is NonNullable<typeof release> => Boolean(release))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 10)
      .map(({ mtimeMs: _mtimeMs, ...release }) => release);
  }

  async #resolveReleaseRootFromInstallEntry(target: ReleaseTarget, installRoot: string): Promise<string | null> {
    const packageRoot = this.#packageRootForInstallRoot(target, installRoot);
    if (await fileExists(packageRoot)) {
      return packageRoot;
    }
    if (await fileExists(path.join(installRoot, RELEASE_METADATA_FILENAME))) {
      return installRoot;
    }
    return null;
  }

  async #readRecentPackageVersions(target: ReleaseTarget): Promise<readonly ReleasePackageVersionInfo[]> {
    const packageName = this.#packageName(target);
    try {
      const result = await this.#exec(this.#npmPath(), [
        "view",
        packageName,
        "versions",
        "--json",
        ...this.#npmRegistryArgs()
      ]);
      return parsePackageVersions(result.stdout, packageName).slice(0, 20);
    } catch (error) {
      logger.warn("Failed to read package versions for deployment status", {
        target,
        packageName,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  async #readLinkedRelease(linkPath: string): Promise<ReleaseInfo> {
    const targetPath = await this.#readLinkTarget(linkPath);
    return {
      linkPath,
      targetPath,
      exists: targetPath ? await fileExists(targetPath) : false,
      metadata: targetPath ? await this.#readReleaseMetadata(targetPath) : null
    };
  }

  async #readReleaseMetadata(releaseRoot: string): Promise<ReleaseMetadata | null> {
    const metadataPath = path.join(releaseRoot, RELEASE_METADATA_FILENAME);
    if (!(await fileExists(metadataPath))) {
      return null;
    }

    const raw = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(raw) as ReleaseMetadata;
  }

  async #readLinkTarget(linkPath: string): Promise<string | null> {
    try {
      const rawTarget = await fs.readlink(linkPath);
      return path.resolve(path.dirname(linkPath), rawTarget);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      if (error && typeof error === "object" && "code" in error && error.code === "EINVAL") {
        return path.resolve(linkPath);
      }
      throw error;
    }
  }

  async #pointLink(linkPath: string, targetPath: string): Promise<void> {
    await ensureDir(path.dirname(linkPath));
    const tempPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
    const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
    await fs.rm(tempPath, { force: true, recursive: true });
    await fs.symlink(relativeTarget, tempPath, "dir");
    await fs.rename(tempPath, linkPath);
  }

  async #isUsablePackageRoot(target: ReleaseTarget, packageRoot: string): Promise<boolean> {
    try {
      await this.#assertUsablePackageRoot(target, packageRoot);
      return true;
    } catch {
      return false;
    }
  }

  async #assertUsablePackageRoot(target: ReleaseTarget, packageRoot: string): Promise<void> {
    const required = target === "admin"
      ? [
          path.join(packageRoot, "dist", "src", "admin-index.js"),
          path.join(packageRoot, "dist", "admin-ui", "index.html"),
          path.join(packageRoot, "scripts", "ops", "macos-bootstrap.mjs"),
          path.join(packageRoot, "scripts", "ops", "macos-launchd-launcher.mjs"),
          path.join(packageRoot, "scripts", "ops", "macos-launchd-restart.mjs")
        ]
      : [
          path.join(packageRoot, "dist", "src", "worker-index.js"),
          path.join(packageRoot, "scripts", "ops", "macos-launchd-launcher.mjs"),
          path.join(packageRoot, "scripts", "ops", "macos-launchd-restart.mjs")
        ];
    for (const filePath of required) {
      if (!(await fileExists(filePath))) {
        throw new Error(`Installed ${target} package is missing required runtime file: ${filePath}`);
      }
    }
  }

  #installRootForVersion(target: ReleaseTarget, version: string): string {
    return path.join(this.options.releasesRoot, target, `npm-${version}`);
  }

  #packageRootForInstallRoot(target: ReleaseTarget, installRoot: string): string {
    return path.join(installRoot, "node_modules", ...this.#packageName(target).split("/"));
  }

  #targetPaths(target: ReleaseTarget): ReleaseTargetPaths {
    return target === "admin"
      ? {
          currentReleasePath: this.options.currentAdminReleasePath,
          previousReleasePath: this.options.previousAdminReleasePath,
          failedReleasePath: this.options.failedAdminReleasePath
        }
      : {
          currentReleasePath: this.options.currentWorkerReleasePath,
          previousReleasePath: this.options.previousWorkerReleasePath,
          failedReleasePath: this.options.failedWorkerReleasePath
        };
  }

  #packageName(target: ReleaseTarget): string {
    return this.options.packages?.[target] || DEFAULT_RELEASE_PACKAGES[target];
  }

  #npmPath(): string {
    return this.options.npmPath || "npm";
  }

  #npmRegistryArgs(): readonly string[] {
    return this.options.npmRegistryUrl ? ["--registry", this.options.npmRegistryUrl] : [];
  }

  async #exec(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string | undefined;
    } = {}
  ) {
    const exec = this.options.exec ?? execCommand;
    return await exec(command, args, options.cwd ? { cwd: options.cwd, env: process.env } : { env: process.env });
  }

  #spawnDetached(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
    } = {}
  ): void {
    const spawnDetached = this.options.spawnDetached ?? spawnDetachedCommand;
    spawnDetached(command, args, options);
  }
}

function packageSpec(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

function normalizeReleaseTarget(target: string): ReleaseTarget {
  if (target === "admin" || target === "worker") {
    return target;
  }
  throw new Error(`Invalid release target: ${target}`);
}

function normalizePackageVersion(version: string): string {
  const normalized = String(version || "").trim();
  if (!normalized || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(normalized)) {
    throw new Error(`Invalid package version: ${version}`);
  }
  return normalized;
}

function parsePackageVersions(stdout: string, packageName: string): readonly ReleasePackageVersionInfo[] {
  const parsed = JSON.parse(stdout || "[]") as unknown;
  const versions = Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : [];
  return versions
    .map((version) => String(version || "").trim())
    .filter(Boolean)
    .reverse()
    .map((version) => ({
      version,
      packageSpec: packageSpec(packageName, version)
    }));
}
