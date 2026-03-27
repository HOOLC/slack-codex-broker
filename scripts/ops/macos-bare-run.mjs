#!/usr/bin/env node

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { getDataRootSource, inspectContainer, repoRoot, runCommand } from "./lib.mjs";

const DEFAULT_CONTAINER_NAME = "slack-codex-broker-real";
const DEFAULT_TARGET = "admin@fd7a:115c:a1e0::c232:b25a";
const DEFAULT_REMOTE_ROOT = "~/services/slack-codex-broker";
const DEFAULT_LABEL = "com.zzj3720.slack-codex-broker";
const DEFAULT_NODE_PATH = "/opt/homebrew/opt/node@24/bin/node";
const DEFAULT_COREPACK_PATH = "/opt/homebrew/opt/node@24/bin/corepack";
const DEFAULT_CODEX_VERSION = "0.114.0";
const DEFAULT_GEMINI_VERSION = "0.33.0";
const DEFAULT_PNPM_VERSION = runCommand("pnpm", ["-v"], { capture: true });

const CODEX_HOST_HOME_ENTRIES = [
  "AGENT.md",
  "AGENTS.md",
  "memory.md",
  "config.toml",
  "memories",
  "skills",
  "superpowers",
  "rules",
  "vendor_imports"
];

const CODEX_HOME_FILE_ENTRIES = [
  ".credentials.json",
  ".personality_migration",
  "AGENT.md",
  "AGENTS.md",
  "config.toml",
  "memory.md",
  "models_cache.json"
];

const CODEX_HOME_DIRECTORY_ENTRIES = [
  "memories",
  "rules",
  "skills",
  "superpowers",
  "vendor_imports"
];

const GEMINI_HOME_FILES = [
  "settings.json",
  "oauth_creds.json",
  "google_accounts.json"
];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function getRemoteNodeBinDir(nodePath) {
  return path.posix.dirname(nodePath);
}

function getRemoteNpmPath(nodePath) {
  return path.posix.join(getRemoteNodeBinDir(nodePath), "npm");
}

function buildRemoteWsReadyCheckScript(port) {
  return `
const target = "ws://127.0.0.1:${port}";
const timer = setTimeout(() => finish(false, "timeout"), 3000);
function finish(ok, error) {
  clearTimeout(timer);
  const payload = ok ? { ok: true, transport: "ws" } : { ok: false, transport: "ws", error };
  console.log(JSON.stringify(payload));
  process.exit(ok ? 0 : 1);
}
let ws;
try {
  ws = new WebSocket(target);
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
ws.addEventListener("open", () => {
  ws.close();
  finish(true);
});
ws.addEventListener("error", (event) => {
  const reason = event?.error?.message ?? "websocket_open_failed";
  finish(false, reason);
});
`.trim();
}

function parseArgs(argv) {
  const options = {
    command: "deploy",
    containerName: DEFAULT_CONTAINER_NAME,
    target: DEFAULT_TARGET,
    remoteRoot: DEFAULT_REMOTE_ROOT,
    label: DEFAULT_LABEL,
    nodePath: DEFAULT_NODE_PATH,
    corepackPath: DEFAULT_COREPACK_PATH,
    codexVersion: DEFAULT_CODEX_VERSION,
    geminiVersion: DEFAULT_GEMINI_VERSION,
    pnpmVersion: DEFAULT_PNPM_VERSION,
    sourceDataRoot: undefined,
    sourceCodexHome: undefined,
    sourceGeminiHome: undefined,
    sourceAgentsHome: undefined,
    sourceGhConfigHome: undefined,
    tempadUrl: undefined,
    noStart: false
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }

    switch (argument) {
      case "--container":
        options.containerName = argv[index + 1];
        index += 1;
        break;
      case "--target":
        options.target = argv[index + 1];
        index += 1;
        break;
      case "--remote-root":
        options.remoteRoot = argv[index + 1];
        index += 1;
        break;
      case "--label":
        options.label = argv[index + 1];
        index += 1;
        break;
      case "--node-path":
        options.nodePath = argv[index + 1];
        index += 1;
        break;
      case "--corepack-path":
        options.corepackPath = argv[index + 1];
        index += 1;
        break;
      case "--pnpm-version":
        options.pnpmVersion = argv[index + 1];
        index += 1;
        break;
      case "--codex-version":
        options.codexVersion = argv[index + 1];
        index += 1;
        break;
      case "--gemini-version":
        options.geminiVersion = argv[index + 1];
        index += 1;
        break;
      case "--source-data-root":
        options.sourceDataRoot = argv[index + 1];
        index += 1;
        break;
      case "--source-codex-home":
        options.sourceCodexHome = argv[index + 1];
        index += 1;
        break;
      case "--source-gemini-home":
        options.sourceGeminiHome = argv[index + 1];
        index += 1;
        break;
      case "--source-agents-home":
        options.sourceAgentsHome = argv[index + 1];
        index += 1;
        break;
      case "--source-gh-config-home":
        options.sourceGhConfigHome = argv[index + 1];
        index += 1;
        break;
      case "--tempad-url":
        options.tempadUrl = argv[index + 1];
        index += 1;
        break;
      case "--no-start":
        options.noStart = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        positional.push(argument);
        break;
    }
  }

  if (positional[0]) {
    options.command = positional[0];
  }

  return options;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node scripts/ops/macos-bare-run.mjs stage [options]",
      "  node scripts/ops/macos-bare-run.mjs install [options]",
      "  node scripts/ops/macos-bare-run.mjs deploy [options]",
      "  node scripts/ops/macos-bare-run.mjs bootstrap [options]",
      "  node scripts/ops/macos-bare-run.mjs status [options]",
      "  node scripts/ops/macos-bare-run.mjs check [options]",
      "  node scripts/ops/macos-bare-run.mjs start [options]",
      "  node scripts/ops/macos-bare-run.mjs stop [options]",
      "  node scripts/ops/macos-bare-run.mjs restart [options]",
      "",
      "Notes:",
      "  - Stages a clean broker data set onto the macOS VM.",
      "  - Does not migrate historical sessions, inbound backlog, logs, or old workspaces.",
      "  - Preserves broker auth profiles, Codex/Gemini/GitHub login state, and launchd wiring.",
      "",
      "Options:",
      "  --target <user@host>                SSH target, default admin@fd7a:115c:a1e0::c232:b25a",
      "  --remote-root <path>                Remote service root, default ~/services/slack-codex-broker",
      "  --container <name>                  Source Docker container name for live env/data inspection",
      "  --source-data-root <path>           Override the source .data directory",
      "  --source-codex-home <path>          Override the source Codex home snapshot",
      "  --source-gemini-home <path>         Override the source Gemini home snapshot",
      "  --source-agents-home <path>         Override the source .agents snapshot",
      "  --source-gh-config-home <path>      Override the source ~/.config/gh snapshot",
      "  --tempad-url <url>                  Optional helper service URL override for bare-run",
      "  --no-start                          Skip launchd start after deploy",
      "  --label <label>                     Launchd label",
      "  --node-path <path>                  Remote node binary, default /opt/homebrew/opt/node@24/bin/node",
      "  --corepack-path <path>              Remote corepack binary, default /opt/homebrew/opt/node@24/bin/corepack",
      "  --pnpm-version <version>            pnpm version to activate via corepack",
      "  --codex-version <version>           codex CLI version to install remotely",
      "  --gemini-version <version>          gemini CLI version to install remotely"
    ].join("\n")
  );
}

function resolveRemoteRoot(remoteRoot, remoteHome) {
  if (remoteRoot.startsWith("~/")) {
    return remoteRoot.replace(/^~\//, `${remoteHome}/`);
  }

  return remoteRoot;
}

function getInspectEnv(inspect) {
  return Object.fromEntries(
    (inspect.Config?.Env ?? []).map((entry) => {
      const [key, ...rest] = entry.split("=");
      return [key, rest.join("=")];
    })
  );
}

function findMountSource(inspect, destination) {
  return (inspect.Mounts ?? []).find((mount) => mount.Destination === destination)?.Source;
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function runRemoteCommand(target, command, options = {}) {
  const result = spawnSync(
    "ssh",
    ["-6", "-o", "ConnectTimeout=10", target, "bash", "-lc", shellQuote(command)],
    {
      encoding: "utf8",
      stdio: options.capture === false ? "inherit" : ["pipe", "pipe", "pipe"]
    }
  );

  if (result.status !== 0) {
    const details = options.capture === false
      ? ""
      : [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Remote command failed (${result.status ?? "null"}): ${command}${details ? `\n${details}` : ""}`
    );
  }

  return options.capture === false ? "" : String(result.stdout ?? "").trim();
}

async function writeRemoteFile(target, remotePath, content) {
  const result = spawnSync(
    "ssh",
    ["-6", "-o", "ConnectTimeout=10", target, "bash", "-lc", shellQuote(`cat > ${shellQuote(remotePath)}`)],
    {
      encoding: "utf8",
      input: content,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to write remote file ${remotePath}: ${[result.stdout, result.stderr].filter(Boolean).join("\n")}`
    );
  }
}

async function getRemoteHome(target) {
  return await runRemoteCommand(target, "printf '%s' \"$HOME\"");
}

function remotePaths(remoteHome, remoteRoot, label) {
  const serviceRoot = resolveRemoteRoot(remoteRoot, remoteHome);
  return {
    remoteHome,
    serviceRoot,
    appRoot: path.posix.join(serviceRoot, "app"),
    dataRoot: path.posix.join(serviceRoot, ".data"),
    runtimeSupportRoot: path.posix.join(serviceRoot, "runtime-support"),
    codexSupportHome: path.posix.join(serviceRoot, "runtime-support", "codex"),
    geminiSupportHome: path.posix.join(serviceRoot, "runtime-support", "gemini"),
    agentsSupportHome: path.posix.join(serviceRoot, "runtime-support", ".agents"),
    envDir: path.posix.join(serviceRoot, "config"),
    envFile: path.posix.join(serviceRoot, "config", "broker.env"),
    logsDir: path.posix.join(serviceRoot, "logs"),
    plistPath: path.posix.join(remoteHome, "Library", "LaunchAgents", `${label}.plist`),
    stdoutPath: path.posix.join(serviceRoot, "logs", "launchd.out.log"),
    stderrPath: path.posix.join(serviceRoot, "logs", "launchd.err.log")
  };
}

function resolveSourceHomes(sourceDataRoot, options, inspect) {
  const env = getInspectEnv(inspect);

  const codexHome = firstExistingPath([
    options.sourceCodexHome,
    path.join(sourceDataRoot, "codex-home")
  ]);
  if (!codexHome) {
    throw new Error("Could not resolve source Codex home");
  }

  const geminiMountSource =
    (env.GEMINI_HOST_HOME_PATH && findMountSource(inspect, env.GEMINI_HOST_HOME_PATH)) ||
    findMountSource(inspect, "/host-gemini-home");
  const agentsMountSource =
    (env.HOST_AGENTS_CONTAINER_PATH && findMountSource(inspect, env.HOST_AGENTS_CONTAINER_PATH)) ||
    findMountSource(inspect, path.join(os.homedir(), ".agents"));

  return {
    codexHome,
    geminiHome: firstExistingPath([
      options.sourceGeminiHome,
      geminiMountSource,
      path.join(sourceDataRoot, "runtime-home", ".gemini"),
      path.join(os.homedir(), ".gemini")
    ]),
    agentsHome: firstExistingPath([
      options.sourceAgentsHome,
      agentsMountSource,
      path.join(sourceDataRoot, "runtime-home", ".agents"),
      path.join(os.homedir(), ".agents")
    ]),
    ghConfigHome: firstExistingPath([
      options.sourceGhConfigHome,
      path.join(os.homedir(), ".config", "gh")
    ])
  };
}

function buildEnvFromInspect(inspect, paths, options) {
  const env = Object.fromEntries(
    (inspect.Config?.Env ?? [])
      .filter((entry) => {
        const [key] = entry.split("=", 1);
        return ![
          "HOSTNAME",
          "DATA_ROOT",
          "STATE_DIR",
          "JOBS_ROOT",
          "SESSIONS_ROOT",
          "REPOS_ROOT",
          "LOG_DIR",
          "CODEX_HOME",
          "CODEX_HOST_HOME_PATH",
          "CODEX_AUTH_JSON_PATH",
          "GEMINI_HOST_HOME_PATH",
          "GEMINI_HTTP_PROXY",
          "GEMINI_HTTPS_PROXY",
          "GEMINI_ALL_PROXY",
          "BROKER_GEMINI_UI_HELPER",
          "TEMPAD_LINK_SERVICE_URL"
        ].includes(key);
      })
      .map((entry) => {
        const [key, ...rest] = entry.split("=");
        return [key, rest.join("=")];
      })
  );

  const nextEnv = {
    ...env,
    NODE_ENV: "production",
    PATH: "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin",
    PORT: "3000",
    DATA_ROOT: paths.dataRoot,
    STATE_DIR: path.posix.join(paths.dataRoot, "state"),
    JOBS_ROOT: path.posix.join(paths.dataRoot, "jobs"),
    SESSIONS_ROOT: path.posix.join(paths.dataRoot, "sessions"),
    REPOS_ROOT: path.posix.join(paths.dataRoot, "repos"),
    LOG_DIR: path.posix.join(paths.dataRoot, "logs"),
    CODEX_HOME: path.posix.join(paths.dataRoot, "codex-home"),
    CODEX_HOST_HOME_PATH: paths.codexSupportHome,
    CODEX_AUTH_JSON_PATH: path.posix.join(paths.dataRoot, "codex-home", "auth.json"),
    GEMINI_HOST_HOME_PATH: paths.geminiSupportHome,
    CODEX_APP_SERVER_PORT: "4590",
    BROKER_HTTP_BASE_URL: "http://127.0.0.1:3000",
    SERVICE_NAME: "slack-codex-broker",
    BROKER_GEMINI_UI_HELPER: path.posix.join(paths.appRoot, "dist", "src", "tools", "gemini-ui.js")
  };

  if (options.tempadUrl) {
    nextEnv.TEMPAD_LINK_SERVICE_URL = options.tempadUrl;
  }

  return nextEnv;
}

function renderEnvFile(env) {
  return (
    Object.entries(env)
      .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join("\n") + "\n"
  );
}

function renderPlist({ label, nodePath, launcherPath, repoRootPath, envFilePath, stdoutPath, stderrPath }) {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${nodePath}</string>`,
    `    <string>${launcherPath}</string>`,
    "    <string>--repo-root</string>",
    `    <string>${repoRootPath}</string>`,
    "    <string>--env-file</string>",
    `    <string>${envFilePath}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${repoRootPath}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${stdoutPath}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${stderrPath}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

async function fileExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyFileResolved(sourcePath, targetPath) {
  if (!(await fileExists(sourcePath))) {
    return;
  }

  await ensureDir(path.dirname(targetPath));
  const content = await fs.readFile(sourcePath);
  await fs.writeFile(targetPath, content);
}

async function copyDirectoryResolved(sourcePath, targetPath) {
  if (!(await fileExists(sourcePath))) {
    return;
  }

  await ensureDir(path.dirname(targetPath));
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    dereference: true,
    force: true
  });
}

async function writeTextFile(sourcePath, targetPath, fallback = "") {
  await ensureDir(path.dirname(targetPath));
  if (!(await fileExists(sourcePath))) {
    await fs.writeFile(targetPath, fallback, "utf8");
    return;
  }

  const content = await fs.readFile(sourcePath, "utf8");
  await fs.writeFile(targetPath, content, "utf8");
}

async function ensureRelativeSymlink(linkPath, targetPath) {
  await ensureDir(path.dirname(linkPath));
  await fs.rm(linkPath, { force: true, recursive: true });
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
  await fs.symlink(relativeTarget, linkPath, "file");
}

async function copyRecursive(sourcePath, targetPath, options = {}) {
  if (!(await fileExists(sourcePath))) {
    return false;
  }

  await ensureDir(path.dirname(targetPath));
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    dereference: options.dereference ?? true,
    force: true
  });
  return true;
}

async function bootstrapAuthProfiles(sourceCodexHome, dataRoot) {
  const sourceAuthProfilesRoot = path.join(path.dirname(sourceCodexHome), "auth-profiles");
  const targetAuthProfilesRoot = path.join(dataRoot, "auth-profiles");
  const targetProfilesDir = path.join(targetAuthProfilesRoot, "docker", "profiles");
  const targetActivePath = path.join(targetAuthProfilesRoot, "docker", "active.json");
  const sourceActivePath = path.join(sourceAuthProfilesRoot, "docker", "active.json");

  if (await copyRecursive(sourceAuthProfilesRoot, targetAuthProfilesRoot, { dereference: true })) {
    await ensureDir(targetProfilesDir);

    let activeProfileName;
    if (await fileExists(sourceActivePath)) {
      try {
        const linkTarget = await fs.readlink(sourceActivePath);
        activeProfileName = path.basename(linkTarget);
      } catch {
        // The copied active.json may already be a concrete file; fall back to a local profile below.
      }
    }

    const candidateNames = [
      activeProfileName,
      "primary.json"
    ].filter(Boolean);

    let selectedProfilePath;
    for (const candidateName of candidateNames) {
      const candidatePath = path.join(targetProfilesDir, candidateName);
      if (await fileExists(candidatePath)) {
        selectedProfilePath = candidatePath;
        break;
      }
    }

    if (!selectedProfilePath) {
      const entries = await fs.readdir(targetProfilesDir);
      const firstJson = entries.find((entry) => entry.endsWith(".json"));
      if (firstJson) {
        selectedProfilePath = path.join(targetProfilesDir, firstJson);
      }
    }

    if (selectedProfilePath) {
      await fs.rm(targetActivePath, { force: true });
      await ensureRelativeSymlink(targetActivePath, selectedProfilePath);
    }

    return;
  }

  const sourceAuth = path.join(sourceCodexHome, "auth.json");
  const targetProfile = path.join(targetProfilesDir, "primary.json");
  await ensureDir(targetProfilesDir);
  await copyFileResolved(sourceAuth, targetProfile);
  await ensureRelativeSymlink(targetActivePath, targetProfile);
}

async function buildPortableCodexHome(sourceCodexHome, targetCodexHome, targetDataRoot) {
  await ensureDir(targetCodexHome);

  for (const entry of CODEX_HOME_FILE_ENTRIES) {
    if (entry === "memory.md") {
      await writeTextFile(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry), "");
      continue;
    }

    await copyFileResolved(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry));
  }

  for (const entry of CODEX_HOME_DIRECTORY_ENTRIES) {
    await copyDirectoryResolved(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry));
  }

  const activeAuth = path.join(targetDataRoot, "auth-profiles", "docker", "active.json");
  await ensureRelativeSymlink(path.join(targetCodexHome, "auth.json"), activeAuth);
}

async function buildPortableHostCodexHome(sourceCodexHome, targetCodexHome) {
  await ensureDir(targetCodexHome);

  for (const entry of CODEX_HOST_HOME_ENTRIES) {
    const sourcePath = path.join(sourceCodexHome, entry);
    const targetPath = path.join(targetCodexHome, entry);

    if (entry === "AGENT.md" || entry === "AGENTS.md" || entry === "memory.md") {
      await writeTextFile(sourcePath, targetPath, "");
      continue;
    }

    if (entry === "config.toml") {
      await copyFileResolved(sourcePath, targetPath);
      continue;
    }

    await copyDirectoryResolved(sourcePath, targetPath);
  }
}

async function buildPortableGeminiHome(sourceGeminiHome, targetGeminiHome) {
  if (!sourceGeminiHome) {
    return;
  }

  await ensureDir(targetGeminiHome);
  for (const entry of GEMINI_HOME_FILES) {
    await copyFileResolved(path.join(sourceGeminiHome, entry), path.join(targetGeminiHome, entry));
  }
}

async function buildPortableGhConfigHome(sourceGhConfigHome, targetRuntimeHome, options = {}) {
  if (!sourceGhConfigHome) {
    return;
  }

  const targetGhConfigHome = path.join(targetRuntimeHome, ".config", "gh");
  await ensureDir(targetGhConfigHome);
  await copyFileResolved(path.join(sourceGhConfigHome, "config.yml"), path.join(targetGhConfigHome, "config.yml"));

  if (options.includeHostsFile) {
    await copyFileResolved(path.join(sourceGhConfigHome, "hosts.yml"), path.join(targetGhConfigHome, "hosts.yml"));
  }
}

async function initializeCleanRuntimeData(targetDataRoot) {
  await ensureDir(path.join(targetDataRoot, "state", "sessions"));
  await ensureDir(path.join(targetDataRoot, "state", "inbound-messages"));
  await ensureDir(path.join(targetDataRoot, "state", "background-jobs"));
  await ensureDir(path.join(targetDataRoot, "jobs"));
  await ensureDir(path.join(targetDataRoot, "sessions"));
  await ensureDir(path.join(targetDataRoot, "logs", "raw"));
  await ensureDir(path.join(targetDataRoot, "logs", "sessions"));
  await ensureDir(path.join(targetDataRoot, "logs", "jobs"));
  await ensureDir(path.join(targetDataRoot, "repos"));
  await ensureDir(path.join(targetDataRoot, "runtime-home"));
  await ensureDir(path.join(targetDataRoot, "admin-backups", "auth-switches"));
  await fs.writeFile(path.join(targetDataRoot, "state", "processed-event-ids.json"), "[]\n", "utf8");
}

async function createPortableBundle(sourceDataRoot, sourceHomes, env = {}) {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-macos-"));
  const stagingDataRoot = path.join(stagingRoot, ".data");
  const stagingRuntimeSupportRoot = path.join(stagingRoot, "runtime-support");

  await ensureDir(stagingDataRoot);
  await ensureDir(stagingRuntimeSupportRoot);

  await bootstrapAuthProfiles(sourceHomes.codexHome, stagingDataRoot);
  await buildPortableCodexHome(
    sourceHomes.codexHome,
    path.join(stagingDataRoot, "codex-home"),
    stagingDataRoot
  );
  await buildPortableHostCodexHome(
    sourceHomes.codexHome,
    path.join(stagingRuntimeSupportRoot, "codex")
  );
  await buildPortableGeminiHome(
    sourceHomes.geminiHome,
    path.join(stagingRuntimeSupportRoot, "gemini")
  );
  await buildPortableGhConfigHome(
    sourceHomes.ghConfigHome,
    path.join(stagingDataRoot, "runtime-home"),
    {
      includeHostsFile: !env.GH_TOKEN && !env.GITHUB_TOKEN
    }
  );
  if (sourceHomes.agentsHome) {
    await copyDirectoryResolved(sourceHomes.agentsHome, path.join(stagingRuntimeSupportRoot, ".agents"));
  }

  await initializeCleanRuntimeData(stagingDataRoot);

  return {
    stagingRoot,
    stagingDataRoot,
    stagingRuntimeSupportRoot
  };
}

async function syncPortableDirectory(target, sourcePath, destinationPath) {
  const parentDir = path.posix.dirname(destinationPath);
  const remoteExtractCommand = `rm -rf ${destinationPath} && mkdir -p ${parentDir} && tar -xzf - -C ${parentDir}`;
  const tar = spawn(
    "tar",
    ["-czf", "-", "-C", path.dirname(sourcePath), path.basename(sourcePath)],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const ssh = spawn(
    "ssh",
    ["-6", "-o", "ConnectTimeout=10", target, remoteExtractCommand],
    { stdio: ["pipe", "inherit", "pipe"] }
  );

  let tarStderr = "";
  let sshStderr = "";
  tar.stderr.on("data", (chunk) => {
    tarStderr += chunk.toString("utf8");
  });
  ssh.stderr.on("data", (chunk) => {
    sshStderr += chunk.toString("utf8");
  });
  ssh.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") {
      sshStderr += `${error.message}\n`;
    }
  });
  tar.stdout.pipe(ssh.stdin);
  tar.once("close", () => {
    ssh.stdin.end();
  });

  const waitForExit = (child, label) =>
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`${label} exited with ${code ?? "null"}${signal ? ` (${signal})` : ""}`));
      });
    });

  try {
    await Promise.all([waitForExit(tar, "tar"), waitForExit(ssh, "ssh")]);
  } catch (error) {
    tar.kill("SIGTERM");
    ssh.kill("SIGTERM");
    const details = [tarStderr.trim(), sshStderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `Failed to sync ${sourcePath} to ${target}:${destinationPath}: ${error.message}${details ? `\n${details}` : ""}`
    );
  }
}

async function syncRepoCode(target, destinationPath) {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-app-"));
  const stagingPath = path.join(stagingRoot, path.basename(destinationPath));
  try {
    await fs.cp(repoRoot, stagingPath, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (inputPath) => {
        const relative = path.relative(repoRoot, inputPath);
        if (!relative || relative === ".") {
          return true;
        }

        return ![
          ".git",
          ".data",
          ".data-real",
          ".data-real-cueboard",
          ".backups",
          "coverage",
          "dist",
          "node_modules"
        ].some((prefix) => relative === prefix || relative.startsWith(`${prefix}${path.sep}`));
      }
    });

    await syncPortableDirectory(target, stagingPath, destinationPath);
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function installRemoteTooling(target, options) {
  const npmPath = getRemoteNpmPath(options.nodePath);
  const installCommand = [
    `${shellQuote(options.corepackPath)} enable`,
    `${shellQuote(options.corepackPath)} prepare pnpm@${shellQuote(options.pnpmVersion)} --activate`,
    `${shellQuote(npmPath)} install -g --force @openai/codex@${shellQuote(options.codexVersion)} @google/gemini-cli@${shellQuote(options.geminiVersion)}`
  ].join(" && ");

  await runRemoteCommand(target, installCommand);
}

async function writeLaunchdFiles(target, paths, env, options) {
  const launcherPath = path.posix.join(paths.appRoot, "scripts", "ops", "macos-launchd-launcher.mjs");
  const rendered = renderPlist({
    label: options.label,
    nodePath: options.nodePath,
    launcherPath,
    repoRootPath: paths.appRoot,
    envFilePath: paths.envFile,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath
  });

  await runRemoteCommand(target, `mkdir -p ${shellQuote(path.posix.dirname(paths.plistPath))}`);
  await writeRemoteFile(target, paths.plistPath, rendered);
  await runRemoteCommand(target, `mkdir -p ${shellQuote(path.posix.dirname(paths.envFile))}`);
  await writeRemoteFile(target, paths.envFile, renderEnvFile(env));
}

async function launchService(target, paths, options) {
  const loadCommand = [
    `launchctl bootout gui/$(id -u) ${shellQuote(paths.plistPath)} >/dev/null 2>&1 || true`,
    `launchctl bootstrap gui/$(id -u) ${shellQuote(paths.plistPath)}`,
    `launchctl kickstart -k gui/$(id -u)/${options.label}`
  ].join(" && ");
  await runRemoteCommand(target, loadCommand);
}

async function unloadService(target, paths) {
  await runRemoteCommand(
    target,
    `launchctl bootout gui/$(id -u) ${shellQuote(paths.plistPath)} >/dev/null 2>&1 || true`
  );
}

async function readRemoteStatus(target, paths, options) {
  const readyScript = buildRemoteWsReadyCheckScript(4590);
  const launchd = await runRemoteCommand(
    target,
    [
      `launchctl print gui/$(id -u)/${options.label} 2>/dev/null || true`,
      "printf '\\n---\\n'",
      `launchctl list | grep ${shellQuote(options.label)} || true`
    ].join(" && ")
  );

  const health = await runRemoteCommand(target, "curl --connect-timeout 1 --max-time 3 -fsS http://127.0.0.1:3000/ || true");
  const ready = await runRemoteCommand(
    target,
    `${shellQuote(options.nodePath)} -e ${shellQuote(readyScript)} || true`
  );
  const nodeVersion = await runRemoteCommand(target, `${shellQuote(options.nodePath)} -v || true`);
  const pnpmVersion = await runRemoteCommand(target, `${shellQuote(options.corepackPath)} pnpm -v || true`);
  const codexVersion = await runRemoteCommand(target, "codex --version || true");
  const geminiVersion = await runRemoteCommand(target, "gemini --version || true");

  return {
    launchd,
    health,
    ready,
    nodeVersion,
    pnpmVersion,
    codexVersion,
    geminiVersion
  };
}

async function stagePortableRuntime(options) {
  const inspect = inspectContainer(options.containerName);
  const sourceDataRoot = options.sourceDataRoot ?? getDataRootSource(inspect);
  const sourceHomes = resolveSourceHomes(sourceDataRoot, options, inspect);
  const remoteHome = await getRemoteHome(options.target);
  const paths = remotePaths(remoteHome, options.remoteRoot, options.label);
  const env = buildEnvFromInspect(inspect, paths, options);
  const bundle = await createPortableBundle(sourceDataRoot, sourceHomes, env);

  try {
    const legacySupportRoot = path.posix.join(paths.serviceRoot, "host-homes");
    await runRemoteCommand(
      options.target,
      `rm -rf ${shellQuote(legacySupportRoot)} ${shellQuote(paths.runtimeSupportRoot)} && mkdir -p ${shellQuote(paths.serviceRoot)} ${shellQuote(paths.appRoot)} ${shellQuote(paths.dataRoot)} ${shellQuote(paths.runtimeSupportRoot)} ${shellQuote(paths.envDir)} ${shellQuote(paths.logsDir)} ${shellQuote(path.posix.dirname(paths.plistPath))}`
    );

    await syncPortableDirectory(options.target, bundle.stagingDataRoot, paths.dataRoot);
    await syncPortableDirectory(options.target, bundle.stagingRuntimeSupportRoot, paths.runtimeSupportRoot);
    await syncRepoCode(options.target, paths.appRoot);
    await writeLaunchdFiles(options.target, paths, env, options);

    return {
      paths,
      sourceDataRoot,
      sourceHomes
    };
  } finally {
    await fs.rm(bundle.stagingRoot, { recursive: true, force: true });
  }
}

async function commandStage(options) {
  const staged = await stagePortableRuntime(options);
  return {
    ok: true,
    ...staged
  };
}

async function commandInstall(options) {
  const staged = await stagePortableRuntime(options);
  await installRemoteTooling(options.target, options);
  await runRemoteCommand(
    options.target,
    `cd ${shellQuote(staged.paths.appRoot)} && ${shellQuote(options.corepackPath)} pnpm install --frozen-lockfile && ${shellQuote(options.corepackPath)} pnpm build && ${shellQuote(options.corepackPath)} pnpm install --prod --frozen-lockfile`
  );

  return {
    ok: true,
    ...staged
  };
}

async function commandDeploy(options) {
  const installed = await commandInstall(options);

  if (!options.noStart) {
    await launchService(options.target, installed.paths, options);
  }

  return {
    ok: true,
    ...installed,
    ...(options.noStart
      ? {}
      : {
          status: await readRemoteStatus(options.target, installed.paths, options)
        })
  };
}

async function commandBootstrap(options) {
  return await commandDeploy(options);
}

async function commandStatus(options) {
  const remoteHome = await getRemoteHome(options.target);
  const paths = remotePaths(remoteHome, options.remoteRoot, options.label);
  return {
    ok: true,
    target: options.target,
    paths,
    ...(await readRemoteStatus(options.target, paths, options))
  };
}

async function commandCheck(options) {
  const status = await commandStatus(options);
  const missing = [];

  if (!status.launchd.includes(options.label)) {
    missing.push("launchd");
  }
  if (!String(status.health || "").includes('"ok"')) {
    missing.push("health");
  }
  if (!String(status.ready || "").includes('"ok"')) {
    missing.push("ready");
  }
  if (missing.length > 0) {
    throw new Error(`macOS bare-run check failed: ${missing.join(", ")}`);
  }

  return status;
}

async function commandStart(options) {
  const remoteHome = await getRemoteHome(options.target);
  const paths = remotePaths(remoteHome, options.remoteRoot, options.label);
  await launchService(options.target, paths, options);
  return await readRemoteStatus(options.target, paths, options);
}

async function commandStop(options) {
  const remoteHome = await getRemoteHome(options.target);
  const paths = remotePaths(remoteHome, options.remoteRoot, options.label);
  await unloadService(options.target, paths);
  return {
    ok: true,
    paths
  };
}

async function commandRestart(options) {
  const stopResult = await commandStop(options);
  const startResult = await commandStart(options);
  return {
    ok: true,
    stopResult,
    startResult
  };
}

const options = parseArgs(process.argv.slice(2));

let result;
switch (options.command) {
  case "stage":
    result = await commandStage(options);
    break;
  case "install":
    result = await commandInstall(options);
    break;
  case "deploy":
    result = await commandDeploy(options);
    break;
  case "bootstrap":
    result = await commandBootstrap(options);
    break;
  case "status":
    result = await commandStatus(options);
    break;
  case "check":
    result = await commandCheck(options);
    break;
  case "start":
    result = await commandStart(options);
    break;
  case "stop":
    result = await commandStop(options);
    break;
  case "restart":
    result = await commandRestart(options);
    break;
  default:
    throw new Error(`Unsupported command: ${options.command}`);
}

console.log(JSON.stringify(result, null, 2));
