#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawn } from "node:child_process";

interface ParsedArgs {
  readonly cwd?: string | undefined;
  readonly includeDirectories: readonly string[];
  readonly model?: string | undefined;
  readonly prompt?: string | undefined;
  readonly promptFile?: string | undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = await resolvePrompt(args);
  if (!prompt.trim()) {
    throw new Error("missing Gemini UI prompt");
  }

  const env = buildGeminiEnv();
  const model = args.model?.trim() || "gemini-3-pro-preview";
  const cliArgs = buildCliArgs(prompt, args.includeDirectories, model);
  const attempt = await runGemini(cliArgs, args.cwd, env);
  if (attempt.ok) {
    return;
  }

  throw new Error(
    `gemini exited with code ${attempt.code ?? "null"}${attempt.signal ? ` (signal ${attempt.signal})` : ""}`
  );
}

function buildCliArgs(
  prompt: string,
  includeDirectories: readonly string[],
  model: string
): string[] {
  const cliArgs = ["--prompt", prompt, "--output-format", "text", "--yolo", "--model", model];

  for (const includeDirectory of includeDirectories) {
    cliArgs.push("--include-directories", includeDirectory);
  }

  return cliArgs;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let cwd: string | undefined;
  let model: string | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  const includeDirectories: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    const next = argv[index + 1];

    if (entry === "--cwd") {
      cwd = readValue(entry, next);
      index += 1;
      continue;
    }

    if (entry === "--model") {
      model = readValue(entry, next);
      index += 1;
      continue;
    }

    if (entry === "--prompt") {
      prompt = readValue(entry, next);
      index += 1;
      continue;
    }

    if (entry === "--prompt-file") {
      promptFile = readValue(entry, next);
      index += 1;
      continue;
    }

    if (entry === "--include-directory") {
      includeDirectories.push(readValue(entry, next));
      index += 1;
      continue;
    }

    throw new Error(`unexpected argument: ${entry}`);
  }

  return {
    cwd,
    includeDirectories,
    model,
    prompt,
    promptFile
  };
}

function readValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }

  return value;
}

async function resolvePrompt(args: ParsedArgs): Promise<string> {
  if (args.promptFile) {
    return await fs.readFile(args.promptFile, "utf8");
  }

  if (args.prompt) {
    return args.prompt;
  }

  const stdin = await readStdin();
  return stdin;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function buildGeminiEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env
  };

  mapProxyEnv(env, "BROKER_GEMINI_HTTP_PROXY", "HTTP_PROXY", "http_proxy");
  mapProxyEnv(env, "BROKER_GEMINI_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy");
  mapProxyEnv(env, "BROKER_GEMINI_ALL_PROXY", "ALL_PROXY", "all_proxy");

  return env;
}

async function runGemini(
  cliArgs: readonly string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<{ ok: true } | { ok: false; code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("gemini", cliArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(chunk);
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }

      resolve({
        ok: false,
        code,
        signal,
        stderr
      });
    });
  });
}


function mapProxyEnv(
  env: NodeJS.ProcessEnv,
  sourceKey: "BROKER_GEMINI_HTTP_PROXY" | "BROKER_GEMINI_HTTPS_PROXY" | "BROKER_GEMINI_ALL_PROXY",
  uppercaseKey: "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY",
  lowercaseKey: "http_proxy" | "https_proxy" | "all_proxy"
): void {
  const value = env[sourceKey]?.trim();
  if (!value) {
    return;
  }

  env[uppercaseKey] = value;
  env[lowercaseKey] = value;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
