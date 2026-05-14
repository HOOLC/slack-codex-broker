import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("macOS bootstrap", () => {
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

  it("writes admin and worker launchd agents that both run from the current release", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-bootstrap-"));
    tempDirs.push(tempRoot);

    const home = path.join(tempRoot, "home");
    const fakeBin = path.join(tempRoot, "bin");
    const serviceRoot = path.join(tempRoot, "service");
    const commandLog = path.join(tempRoot, "commands.log");
    const packageVersion = "0.2.0";

    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.mkdir(serviceRoot, { recursive: true });
    await writeExecutable(path.join(fakeBin, "npm"), fakeNpmScript());
    await writeExecutable(path.join(fakeBin, "launchctl"), fakeCommandScript("launchctl"));
    await writeExecutable(path.join(fakeBin, "node"), fakeCommandScript("node"));

    const result = await runNodeScript(
      [
        "scripts/ops/macos-bootstrap.mjs",
        "--service-root",
        serviceRoot,
        "--label",
        "test.admin",
        "--worker-label",
        "test.worker",
        "--node-path",
        path.join(fakeBin, "node"),
        "--npm-path",
        path.join(fakeBin, "npm"),
        "--package-version",
        packageVersion
      ],
      {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        FAKE_COMMAND_LOG: commandLog
      }
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      serviceRoot,
      currentAdminReleasePath: path.join(serviceRoot, "current-admin"),
      currentWorkerReleasePath: path.join(serviceRoot, "current-worker"),
      workerStarted: false
    });

    const currentAdminReleasePath = path.join(serviceRoot, "current-admin");
    const currentWorkerReleasePath = path.join(serviceRoot, "current-worker");
    const adminReleaseRoot = path.join(serviceRoot, "releases", "admin", `npm-${packageVersion}`, "node_modules", "@agent-session-broker", "admin");
    const workerReleaseRoot = path.join(serviceRoot, "releases", "worker", `npm-${packageVersion}`, "node_modules", "@agent-session-broker", "worker");
    await expect(fs.readlink(currentAdminReleasePath)).resolves.toBe(path.relative(serviceRoot, adminReleaseRoot));
    await expect(fs.readlink(currentWorkerReleasePath)).resolves.toBe(path.relative(serviceRoot, workerReleaseRoot));

    const adminPlist = await fs.readFile(path.join(home, "Library", "LaunchAgents", "test.admin.plist"), "utf8");
    const workerPlist = await fs.readFile(path.join(home, "Library", "LaunchAgents", "test.worker.plist"), "utf8");
    const adminEnv = await fs.readFile(path.join(serviceRoot, "config", "admin.env"), "utf8");
    const adminLauncherPath = path.join(currentAdminReleasePath, "scripts", "ops", "macos-launchd-launcher.mjs");
    const workerLauncherPath = path.join(currentWorkerReleasePath, "scripts", "ops", "macos-launchd-launcher.mjs");
    const adminPlistPath = path.join(home, "Library", "LaunchAgents", "test.admin.plist");
    const workerPlistPath = path.join(home, "Library", "LaunchAgents", "test.worker.plist");

    expectLaunchdRuntime(adminPlist, {
      launcherPath: adminLauncherPath,
      repoRootPath: currentAdminReleasePath,
      entryPoint: "dist/src/admin-index.js"
    });
    expectLaunchdRuntime(workerPlist, {
      launcherPath: workerLauncherPath,
      repoRootPath: currentWorkerReleasePath,
      entryPoint: "dist/src/worker-index.js"
    });
    expect(adminEnv).toContain(`ADMIN_PLIST_PATH="${adminPlistPath}"`);
    expect(adminEnv).toContain(`WORKER_PLIST_PATH="${workerPlistPath}"`);
  }, 15_000);
});

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, `${content}\n`, "utf8");
  await fs.chmod(filePath, 0o755);
}

function fakeCommandScript(command: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `echo "${command} $*" >> "$FAKE_COMMAND_LOG"`
  ].join("\n");
}

function fakeNpmScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "echo \"npm $*\" >> \"$FAKE_COMMAND_LOG\"",
    "if [ \"${1:-}\" = \"install\" ] && [ \"${2:-}\" = \"--prefix\" ]; then",
    "  prefix=\"$3\"",
    "  last=\"\"",
    "  for arg in \"$@\"; do last=\"$arg\"; done",
    "  version=\"${last##*@}\"",
    "  package_name=\"${last%@*}\"",
    "  package_path=\"$(printf '%s' \"$package_name\" | sed 's#/# #g')\"",
    "  set -- $package_path",
    "  package_root=\"$prefix/node_modules/$1/$2\"",
    "  mkdir -p \"$package_root/dist/src\" \"$package_root/scripts/ops\"",
    "  if [ \"$package_name\" = \"@agent-session-broker/admin\" ]; then",
    "    mkdir -p \"$package_root/dist/admin-ui\"",
    "    : > \"$package_root/dist/src/admin-index.js\"",
    "    : > \"$package_root/dist/admin-ui/index.html\"",
    "    : > \"$package_root/scripts/ops/macos-bootstrap.mjs\"",
    "  fi",
    "  if [ \"$package_name\" = \"@agent-session-broker/worker\" ]; then",
    "    : > \"$package_root/dist/src/worker-index.js\"",
    "  fi",
    "  : > \"$package_root/scripts/ops/macos-launchd-launcher.mjs\"",
    "  : > \"$package_root/scripts/ops/macos-launchd-restart.mjs\"",
    "  printf '{\"name\":\"%s\",\"version\":\"%s\"}\\n' \"$package_name\" \"$version\" > \"$package_root/package.json\"",
    "fi"
  ].join("\n");
}

function runNodeScript(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({
        status,
        stdout,
        stderr
      });
    });
  });
}

function expectLaunchdRuntime(
  plist: string,
  expected: {
    readonly launcherPath: string;
    readonly repoRootPath: string;
    readonly entryPoint: string;
  }
): void {
  expect(plist).toContain(`<string>${expected.launcherPath}</string>`);
  expect(plist).toContain([
    "    <string>--repo-root</string>",
    `    <string>${expected.repoRootPath}</string>`
  ].join("\n"));
  expect(plist).toContain([
    "    <string>--entry-point</string>",
    `    <string>${expected.entryPoint}</string>`
  ].join("\n"));
  expect(plist).toContain([
    "  <key>WorkingDirectory</key>",
    `  <string>${expected.repoRootPath}</string>`
  ].join("\n"));
}
