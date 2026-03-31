#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = {
    envFile: undefined,
    repoRoot: undefined,
    entryPoint: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }

    switch (argument) {
      case "--env-file":
        options.envFile = argv[index + 1];
        index += 1;
        break;
      case "--repo-root":
        options.repoRoot = argv[index + 1];
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log("Usage: node scripts/ops/macos-launchd-launcher.mjs --repo-root <path> --env-file <path> --entry-point <path>");
        process.exit(0);
      case "--entry-point":
        options.entryPoint = argv[index + 1];
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.envFile) {
    throw new Error("Missing required argument: --env-file");
  }

  if (!options.repoRoot) {
    throw new Error("Missing required argument: --repo-root");
  }

  if (!options.entryPoint) {
    throw new Error("Missing required argument: --entry-point");
  }

  return options;
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

    env[key] = value;
  }

  return env;
}

const options = parseArgs(process.argv.slice(2));
const envText = await fs.readFile(options.envFile, "utf8");
const env = parseEnvFile(envText);

for (const [key, value] of Object.entries(env)) {
  process.env[key] = value;
}

process.chdir(options.repoRoot);

const entryPoint = path.resolve(options.repoRoot, options.entryPoint);
await import(pathToFileURL(entryPoint).href);
