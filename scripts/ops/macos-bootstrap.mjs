#!/usr/bin/env node

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repoRoot, runCommand } from "./lib.mjs";

const DEFAULT_SERVICE_ROOT = repoRoot;
const DEFAULT_ADMIN_LABEL = "io.github.hoolc.agent-session-broker";
const DEFAULT_WORKER_LABEL = "io.github.hoolc.agent-session-broker.worker";
const DEFAULT_NODE_PATH = "/opt/homebrew/opt/node@24/bin/node";
const DEFAULT_CODEX_VERSION = "0.114.0";
const DEFAULT_GEMINI_VERSION = "0.33.0";
const DEFAULT_PACKAGE_INFO = readDefaultPackageInfo();
const RELEASE_METADATA_FILENAME = ".broker-release.json";

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

const BROKER_ENV_PASSTHROUGH_KEYS = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_API_BASE_URL",
  "SLACK_SOCKET_OPEN_URL",
  "SLACK_INITIAL_THREAD_HISTORY_COUNT",
  "SLACK_HISTORY_API_MAX_LIMIT",
  "SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS",
  "SLACK_MISSED_THREAD_RECOVERY_INTERVAL_MS",
  "LOG_LEVEL",
  "LOG_RAW_SLACK_EVENTS",
  "LOG_RAW_CODEX_RPC",
  "LOG_RAW_HTTP_REQUESTS",
  "ISOLATED_MCP_SERVERS",
  "CODEX_DISABLED_MCP_SERVERS",
  "CODEX_APP_SERVER_URL",
  "OPENAI_API_KEY",
  "TEMPAD_LINK_SERVICE_URL",
  "GEMINI_HTTP_PROXY",
  "GEMINI_HTTPS_PROXY",
  "GEMINI_ALL_PROXY",
  "BROKER_ADMIN_TOKEN"
];

function readDefaultPackageInfo() {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    return {
      adminName: "@agent-session-broker/admin",
      workerName: "@agent-session-broker/worker",
      version: packageJson.version || "latest"
    };
  } catch {
    return {
      adminName: "@agent-session-broker/admin",
      workerName: "@agent-session-broker/worker",
      version: "latest"
    };
  }
}

function parseArgs(argv) {
  const options = {
    serviceRoot: DEFAULT_SERVICE_ROOT,
    adminLabel: DEFAULT_ADMIN_LABEL,
    workerLabel: DEFAULT_WORKER_LABEL,
    nodePath: DEFAULT_NODE_PATH,
    npmPath: undefined,
    adminPackageName: DEFAULT_PACKAGE_INFO.adminName,
    workerPackageName: DEFAULT_PACKAGE_INFO.workerName,
    packageVersion: DEFAULT_PACKAGE_INFO.version,
    npmRegistryUrl: undefined,
    codexVersion: DEFAULT_CODEX_VERSION,
    geminiVersion: DEFAULT_GEMINI_VERSION,
    startWorker: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--service-root":
        options.serviceRoot = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--label":
        options.adminLabel = argv[index + 1];
        index += 1;
        break;
      case "--worker-label":
        options.workerLabel = argv[index + 1];
        index += 1;
        break;
      case "--node-path":
        options.nodePath = argv[index + 1];
        index += 1;
        break;
      case "--npm-path":
        options.npmPath = argv[index + 1];
        index += 1;
        break;
      case "--admin-package-name":
        options.adminPackageName = argv[index + 1];
        index += 1;
        break;
      case "--worker-package-name":
        options.workerPackageName = argv[index + 1];
        index += 1;
        break;
      case "--package-version":
        options.packageVersion = argv[index + 1];
        index += 1;
        break;
      case "--npm-registry-url":
        options.npmRegistryUrl = argv[index + 1];
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
      case "--start-worker":
        options.startWorker = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node scripts/ops/macos-bootstrap.mjs [options]",
      "",
      "What it does:",
      "  - prepares shared runtime directories under the service root",
      "  - installs built admin and worker npm packages under releases/<target>/npm-<version>",
      "  - writes admin/worker launchd plists and env files",
      "  - starts admin immediately; worker is optional",
      "",
      "Notes:",
      "  - preferred flow: install the admin package, then run this script with --package-version",
      "  - auth.json is not copied by this script; import auth profiles later through /admin",
      "  - Slack tokens come from the current shell env or an existing config/broker.env",
      "",
      "Options:",
      `  --service-root <path>                Service root, default ${DEFAULT_SERVICE_ROOT}`,
      `  --label <label>                     Admin launchd label, default ${DEFAULT_ADMIN_LABEL}`,
      `  --worker-label <label>              Worker launchd label, default ${DEFAULT_WORKER_LABEL}`,
      "  --start-worker                      Also start the worker after bootstrap",
      "  --node-path <path>                  Node binary for launchd",
      "  --npm-path <path>                   npm binary, default next to --node-path",
      "  --admin-package-name <name>         Admin npm package name",
      "  --worker-package-name <name>        Worker npm package name",
      "  --package-version <version>         Broker npm package version",
      "  --npm-registry-url <url>            Optional npm registry URL",
      "  --codex-version <version>           codex CLI version to install globally",
      "  --gemini-version <version>          gemini CLI version to install globally"
    ].join("\n")
  );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    let value = rawValue;
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }

    env[key] = String(value);
  }

  return env;
}

async function fileExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readExistingBrokerEnv(serviceRoot) {
  const envFilePath = path.join(serviceRoot, "config", "broker.env");
  if (!(await fileExists(envFilePath))) {
    return {};
  }

  return parseEnvFile(await fs.readFile(envFilePath, "utf8"));
}

function buildSeedBrokerEnv(existingBrokerEnv) {
  const merged = {};
  for (const key of BROKER_ENV_PASSTHROUGH_KEYS) {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== null && String(fromProcess).length > 0) {
      merged[key] = String(fromProcess);
      continue;
    }

    const fromExisting = existingBrokerEnv[key];
    if (fromExisting !== undefined && fromExisting !== null && String(fromExisting).length > 0) {
      merged[key] = String(fromExisting);
    }
  }

  return merged;
}

function assertRequiredBrokerEnv(seedBrokerEnv) {
  const missing = ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"].filter((key) => !seedBrokerEnv[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required broker environment values: ${missing.join(", ")}. ` +
      "Provide them in the current shell env or the existing config/broker.env before bootstrap."
    );
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
  await fs.copyFile(sourcePath, targetPath);
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

async function buildPortableCodexHome(sourceCodexHome, targetCodexHome) {
  await ensureDir(targetCodexHome);

  for (const entry of CODEX_HOME_FILE_ENTRIES) {
    if (entry === "memory.md") {
      await writeTextFile(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry), "");
      continue;
    }

    if (entry === ".credentials.json") {
      continue;
    }

    await copyFileResolved(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry));
  }

  for (const entry of CODEX_HOME_DIRECTORY_ENTRIES) {
    await copyDirectoryResolved(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry));
  }

}

async function buildPortableGeminiHome(sourceGeminiHome, targetGeminiHome) {
  if (!(await fileExists(sourceGeminiHome))) {
    return;
  }

  await ensureDir(targetGeminiHome);
  for (const entry of GEMINI_HOME_FILES) {
    await copyFileResolved(path.join(sourceGeminiHome, entry), path.join(targetGeminiHome, entry));
  }
}

async function buildPortableGhConfigHome(sourceGhConfigHome, targetRuntimeHome) {
  if (!(await fileExists(sourceGhConfigHome))) {
    return;
  }

  const targetGhConfigHome = path.join(targetRuntimeHome, ".config", "gh");
  await ensureDir(targetGhConfigHome);
  await copyFileResolved(path.join(sourceGhConfigHome, "config.yml"), path.join(targetGhConfigHome, "config.yml"));
  await copyFileResolved(path.join(sourceGhConfigHome, "hosts.yml"), path.join(targetGhConfigHome, "hosts.yml"));
}

async function initializeRuntimeData(dataRoot) {
  await ensureDir(path.join(dataRoot, "state"));
  await ensureDir(path.join(dataRoot, "jobs"));
  await ensureDir(path.join(dataRoot, "sessions"));
  await ensureDir(path.join(dataRoot, "logs", "raw"));
  await ensureDir(path.join(dataRoot, "logs", "sessions"));
  await ensureDir(path.join(dataRoot, "logs", "jobs"));
  await ensureDir(path.join(dataRoot, "repos"));
  await ensureDir(path.join(dataRoot, "runtime-home"));
  await ensureDir(path.join(dataRoot, "auth-profiles", "docker", "profiles"));
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

function renderPlist({ label, nodePath, launcherPath, repoRootPath, envFilePath, entryPoint, stdoutPath, stderrPath }) {
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
    "    <string>--entry-point</string>",
    `    <string>${entryPoint}</string>`,
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

function buildPaths(serviceRoot, options) {
  const remoteHome = os.homedir();
  return {
    serviceRoot,
    repoRoot: serviceRoot,
    releasesRoot: path.join(serviceRoot, "releases"),
    currentAdminReleasePath: path.join(serviceRoot, "current-admin"),
    previousAdminReleasePath: path.join(serviceRoot, "previous-admin"),
    failedAdminReleasePath: path.join(serviceRoot, "failed-admin"),
    currentWorkerReleasePath: path.join(serviceRoot, "current-worker"),
    previousWorkerReleasePath: path.join(serviceRoot, "previous-worker"),
    failedWorkerReleasePath: path.join(serviceRoot, "failed-worker"),
    dataRoot: path.join(serviceRoot, ".data"),
    runtimeSupportRoot: path.join(serviceRoot, "runtime-support"),
    codexSupportHome: path.join(serviceRoot, "runtime-support", "codex"),
    geminiSupportHome: path.join(serviceRoot, "runtime-support", "gemini"),
    agentsSupportHome: path.join(serviceRoot, "runtime-support", ".agents"),
    envDir: path.join(serviceRoot, "config"),
    adminEnvFile: path.join(serviceRoot, "config", "admin.env"),
    workerEnvFile: path.join(serviceRoot, "config", "worker.env"),
    logsDir: path.join(serviceRoot, "logs"),
    adminPlistPath: path.join(remoteHome, "Library", "LaunchAgents", `${options.adminLabel}.plist`),
    workerPlistPath: path.join(remoteHome, "Library", "LaunchAgents", `${options.workerLabel}.plist`),
    adminStdoutPath: path.join(serviceRoot, "logs", "admin.launchd.out.log"),
    adminStderrPath: path.join(serviceRoot, "logs", "admin.launchd.err.log"),
    workerStdoutPath: path.join(serviceRoot, "logs", "worker.launchd.out.log"),
    workerStderrPath: path.join(serviceRoot, "logs", "worker.launchd.err.log")
  };
}

function buildReleaseMetadata(target, packageName, packageVersion) {
  return {
    revision: null,
    shortRevision: null,
    branch: null,
    target,
    packageName,
    packageVersion,
    packageSpec: packageSpec(packageName, packageVersion),
    requestedVersion: packageVersion,
    installedAt: new Date().toISOString(),
    installedBy: os.userInfo().username,
    installedFromHost: os.hostname(),
    stateSchemaVersion: 3
  };
}

function packageSpec(packageName, version) {
  return `${packageName}@${version}`;
}

function packageRootForInstallRoot(installRoot, packageName) {
  return path.join(installRoot, "node_modules", ...packageName.split("/"));
}

function normalizePackageVersion(version) {
  const normalized = String(version || "").trim();
  if (!normalized || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(normalized)) {
    throw new Error(`Invalid package version: ${version}`);
  }
  return normalized;
}

function buildAdminEnv(paths, options, seedBrokerEnv) {
  return {
    ...seedBrokerEnv,
    NODE_ENV: "production",
    PATH: "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin",
    PORT: "3000",
    ADMIN_BASE_URL: "http://127.0.0.1:3000",
    WORKER_PORT: "3001",
    WORKER_BIND_HOST: "127.0.0.1",
    WORKER_BASE_URL: "http://127.0.0.1:3001",
    BROKER_HTTP_BASE_URL: "http://127.0.0.1:3001",
    SERVICE_NAME: "slack-codex-broker-admin",
    SERVICE_ROOT: paths.serviceRoot,
    DATA_ROOT: paths.dataRoot,
    STATE_DIR: path.join(paths.dataRoot, "state"),
    JOBS_ROOT: path.join(paths.dataRoot, "jobs"),
    SESSIONS_ROOT: path.join(paths.dataRoot, "sessions"),
    REPOS_ROOT: path.join(paths.dataRoot, "repos"),
    LOG_DIR: path.join(paths.dataRoot, "logs"),
    CODEX_HOME: path.join(paths.dataRoot, "codex-home"),
    CODEX_HOST_HOME_PATH: paths.codexSupportHome,
    CODEX_AUTH_JSON_PATH: path.join(paths.dataRoot, "codex-home", "auth.json"),
    GEMINI_HOST_HOME_PATH: paths.geminiSupportHome,
    CODEX_APP_SERVER_PORT: "4590",
    ADMIN_LAUNCHD_LABEL: options.adminLabel,
    WORKER_LAUNCHD_LABEL: options.workerLabel,
    ADMIN_PLIST_PATH: paths.adminPlistPath,
    RELEASE_ADMIN_PACKAGE_NAME: options.adminPackageName,
    RELEASE_WORKER_PACKAGE_NAME: options.workerPackageName,
    ...(options.npmRegistryUrl ? { RELEASE_NPM_REGISTRY_URL: options.npmRegistryUrl } : {}),
    RELEASES_ROOT: paths.releasesRoot,
    CURRENT_ADMIN_RELEASE_PATH: paths.currentAdminReleasePath,
    PREVIOUS_ADMIN_RELEASE_PATH: paths.previousAdminReleasePath,
    FAILED_ADMIN_RELEASE_PATH: paths.failedAdminReleasePath,
    CURRENT_WORKER_RELEASE_PATH: paths.currentWorkerReleasePath,
    PREVIOUS_WORKER_RELEASE_PATH: paths.previousWorkerReleasePath,
    FAILED_WORKER_RELEASE_PATH: paths.failedWorkerReleasePath,
    WORKER_PLIST_PATH: paths.workerPlistPath
  };
}

function buildWorkerEnv(paths, options, seedBrokerEnv) {
  return {
    ...seedBrokerEnv,
    NODE_ENV: "production",
    PATH: "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin",
    PORT: "3001",
    ADMIN_BASE_URL: "http://127.0.0.1:3000",
    WORKER_PORT: "3001",
    WORKER_BIND_HOST: "127.0.0.1",
    WORKER_BASE_URL: "http://127.0.0.1:3001",
    BROKER_HTTP_BASE_URL: "http://127.0.0.1:3001",
    SERVICE_NAME: "slack-codex-broker-worker",
    SERVICE_ROOT: paths.serviceRoot,
    DATA_ROOT: paths.dataRoot,
    STATE_DIR: path.join(paths.dataRoot, "state"),
    JOBS_ROOT: path.join(paths.dataRoot, "jobs"),
    SESSIONS_ROOT: path.join(paths.dataRoot, "sessions"),
    REPOS_ROOT: path.join(paths.dataRoot, "repos"),
    LOG_DIR: path.join(paths.dataRoot, "logs"),
    CODEX_HOME: path.join(paths.dataRoot, "codex-home"),
    CODEX_HOST_HOME_PATH: paths.codexSupportHome,
    CODEX_AUTH_JSON_PATH: path.join(paths.dataRoot, "codex-home", "auth.json"),
    GEMINI_HOST_HOME_PATH: paths.geminiSupportHome,
    CODEX_APP_SERVER_PORT: "4590",
    ADMIN_LAUNCHD_LABEL: options.adminLabel,
    WORKER_LAUNCHD_LABEL: options.workerLabel,
    ADMIN_PLIST_PATH: paths.adminPlistPath,
    WORKER_PLIST_PATH: paths.workerPlistPath,
    RELEASE_ADMIN_PACKAGE_NAME: options.adminPackageName,
    RELEASE_WORKER_PACKAGE_NAME: options.workerPackageName,
    ...(options.npmRegistryUrl ? { RELEASE_NPM_REGISTRY_URL: options.npmRegistryUrl } : {}),
    RELEASES_ROOT: paths.releasesRoot,
    CURRENT_ADMIN_RELEASE_PATH: paths.currentAdminReleasePath,
    PREVIOUS_ADMIN_RELEASE_PATH: paths.previousAdminReleasePath,
    FAILED_ADMIN_RELEASE_PATH: paths.failedAdminReleasePath,
    CURRENT_WORKER_RELEASE_PATH: paths.currentWorkerReleasePath,
    PREVIOUS_WORKER_RELEASE_PATH: paths.previousWorkerReleasePath,
    FAILED_WORKER_RELEASE_PATH: paths.failedWorkerReleasePath,
    BROKER_GEMINI_UI_HELPER: path.join(paths.currentWorkerReleasePath, "dist", "src", "tools", "gemini-ui.js")
  };
}

async function installTooling(options) {
  const npmPath = options.npmPath || path.join(path.dirname(options.nodePath), "npm");
  runCommand(npmPath, [
    "install",
    "-g",
    "--force",
    `@openai/codex@${options.codexVersion}`,
    `@google/gemini-cli@${options.geminiVersion}`
  ]);
}

async function prepareSharedHomes(paths) {
  const sourceCodexHome = path.join(os.homedir(), ".codex");
  const sourceGeminiHome = path.join(os.homedir(), ".gemini");
  const sourceGhConfigHome = path.join(os.homedir(), ".config", "gh");
  const sourceAgentsHome = path.join(os.homedir(), ".agents");

  await ensureDir(paths.runtimeSupportRoot);
  await ensureDir(paths.dataRoot);
  await initializeRuntimeData(paths.dataRoot);
  await buildPortableCodexHome(sourceCodexHome, path.join(paths.dataRoot, "codex-home"));
  await buildPortableGeminiHome(sourceGeminiHome, paths.geminiSupportHome);
  await buildPortableGhConfigHome(sourceGhConfigHome, path.join(paths.dataRoot, "runtime-home"));
  await copyDirectoryResolved(sourceAgentsHome, paths.agentsSupportHome);
}

async function ensureInitialReleases(paths, options) {
  const version = normalizePackageVersion(options.packageVersion);
  const admin = await ensureInitialReleaseTarget(paths, options, {
    target: "admin",
    packageName: options.adminPackageName,
    currentReleasePath: paths.currentAdminReleasePath
  }, version);
  const worker = await ensureInitialReleaseTarget(paths, options, {
    target: "worker",
    packageName: options.workerPackageName,
    currentReleasePath: paths.currentWorkerReleasePath
  }, version);
  return {
    admin,
    worker
  };
}

async function ensureInitialReleaseTarget(paths, options, targetOptions, version) {
  const installRoot = path.join(paths.releasesRoot, targetOptions.target, `npm-${version}`);
  const releaseRoot = packageRootForInstallRoot(installRoot, targetOptions.packageName);
  const npmPath = options.npmPath || path.join(path.dirname(options.nodePath), "npm");
  await ensureDir(path.dirname(installRoot));
  if (!(await fileExists(releaseRoot))) {
    await fs.rm(installRoot, { recursive: true, force: true });
    runCommand(npmPath, [
      "install",
      "--prefix",
      installRoot,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...(options.npmRegistryUrl ? ["--registry", options.npmRegistryUrl] : []),
      packageSpec(targetOptions.packageName, version)
    ]);
  }
  await fs.writeFile(
    path.join(releaseRoot, RELEASE_METADATA_FILENAME),
    `${JSON.stringify(buildReleaseMetadata(targetOptions.target, targetOptions.packageName, version), null, 2)}\n`,
    "utf8"
  );

  await fs.rm(targetOptions.currentReleasePath, { recursive: true, force: true });
  await fs.symlink(
    path.relative(path.dirname(targetOptions.currentReleasePath), releaseRoot),
    targetOptions.currentReleasePath,
    "dir"
  );
  return {
    packageName: targetOptions.packageName,
    packageVersion: version,
    releaseRoot
  };
}

async function writeLaunchdFiles(paths, options, seedBrokerEnv) {
  const adminLauncherPath = path.join(paths.currentAdminReleasePath, "scripts", "ops", "macos-launchd-launcher.mjs");
  const workerLauncherPath = path.join(paths.currentWorkerReleasePath, "scripts", "ops", "macos-launchd-launcher.mjs");
  const adminPlist = renderPlist({
    label: options.adminLabel,
    nodePath: options.nodePath,
    launcherPath: adminLauncherPath,
    repoRootPath: paths.currentAdminReleasePath,
    envFilePath: paths.adminEnvFile,
    entryPoint: "dist/src/admin-index.js",
    stdoutPath: paths.adminStdoutPath,
    stderrPath: paths.adminStderrPath
  });
  const workerPlist = renderPlist({
    label: options.workerLabel,
    nodePath: options.nodePath,
    launcherPath: workerLauncherPath,
    repoRootPath: paths.currentWorkerReleasePath,
    envFilePath: paths.workerEnvFile,
    entryPoint: "dist/src/worker-index.js",
    stdoutPath: paths.workerStdoutPath,
    stderrPath: paths.workerStderrPath
  });

  await ensureDir(path.dirname(paths.adminPlistPath));
  await ensureDir(paths.envDir);
  await fs.writeFile(paths.adminPlistPath, adminPlist, "utf8");
  await fs.writeFile(paths.workerPlistPath, workerPlist, "utf8");
  await fs.writeFile(paths.adminEnvFile, renderEnvFile(buildAdminEnv(paths, options, seedBrokerEnv)), "utf8");
  await fs.writeFile(paths.workerEnvFile, renderEnvFile(buildWorkerEnv(paths, options, seedBrokerEnv)), "utf8");
}

function launchdDomain(label) {
  return `gui/${process.getuid()}/${label}`;
}

function bootout(plistPath) {
  try {
    runCommand("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath]);
  } catch {
    // ignore missing services
  }
}

function bootstrap(plistPath) {
  runCommand("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
}

function kickstart(label) {
  runCommand("launchctl", ["kickstart", "-k", launchdDomain(label)]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = buildPaths(options.serviceRoot, options);
  const existingBrokerEnv = await readExistingBrokerEnv(paths.serviceRoot);
  const seedBrokerEnv = buildSeedBrokerEnv(existingBrokerEnv);
  assertRequiredBrokerEnv(seedBrokerEnv);

  await prepareSharedHomes(paths);
  await installTooling(options);
  const initialReleases = await ensureInitialReleases(paths, options);
  await writeLaunchdFiles(paths, options, seedBrokerEnv);

  bootout(paths.adminPlistPath);
  bootstrap(paths.adminPlistPath);
  kickstart(options.adminLabel);

  if (options.startWorker) {
    bootout(paths.workerPlistPath);
    bootstrap(paths.workerPlistPath);
    kickstart(options.workerLabel);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        serviceRoot: paths.serviceRoot,
        adminPlistPath: paths.adminPlistPath,
        workerPlistPath: paths.workerPlistPath,
        currentAdminReleasePath: paths.currentAdminReleasePath,
        currentWorkerReleasePath: paths.currentWorkerReleasePath,
        initialReleases,
        workerStarted: options.startWorker
      },
      null,
      2
    )
  );
}

await main();
