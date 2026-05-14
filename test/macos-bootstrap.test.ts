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
      currentReleasePath: path.join(serviceRoot, "current"),
      workerStarted: false
    });

    const currentReleasePath = path.join(serviceRoot, "current");
    const releaseRoot = path.join(serviceRoot, "releases", `npm-${packageVersion}`, "node_modules", "agent-session-broker");
    await expect(fs.readlink(currentReleasePath)).resolves.toBe(path.relative(serviceRoot, releaseRoot));

    const adminPlist = await fs.readFile(path.join(home, "Library", "LaunchAgents", "test.admin.plist"), "utf8");
    const workerPlist = await fs.readFile(path.join(home, "Library", "LaunchAgents", "test.worker.plist"), "utf8");
    const adminEnv = await fs.readFile(path.join(serviceRoot, "config", "admin.env"), "utf8");
    const launcherPath = path.join(currentReleasePath, "scripts", "ops", "macos-launchd-launcher.mjs");
    const adminPlistPath = path.join(home, "Library", "LaunchAgents", "test.admin.plist");
    const workerPlistPath = path.join(home, "Library", "LaunchAgents", "test.worker.plist");

    expectLaunchdRuntime(adminPlist, {
      launcherPath,
      repoRootPath: currentReleasePath,
      entryPoint: "dist/src/admin-index.js"
    });
    expectLaunchdRuntime(workerPlist, {
      launcherPath,
      repoRootPath: currentReleasePath,
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
    "  package_root=\"$prefix/node_modules/agent-session-broker\"",
    "  mkdir -p \"$package_root/dist/src\" \"$package_root/scripts/ops\"",
    "  : > \"$package_root/dist/src/admin-index.js\"",
    "  : > \"$package_root/dist/src/worker-index.js\"",
    "  : > \"$package_root/scripts/ops/macos-launchd-launcher.mjs\"",
    "  : > \"$package_root/scripts/ops/macos-launchd-restart.mjs\"",
    "  printf '{\"name\":\"agent-session-broker\",\"version\":\"%s\"}\\n' \"$version\" > \"$package_root/package.json\"",
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
