import path from "node:path";

import type { AppConfig } from "../config.js";
import { readChatGptUsageSnapshot } from "./codex/chatgpt-usage-api.js";
import type { RuntimeControl } from "./runtime-control.js";

export class AuthFileRuntimeControl implements RuntimeControl {
  readonly #authJsonPath: string;

  constructor(
    config: AppConfig,
    private readonly options: {
      readonly onRestart: (reason: string) => Promise<void>;
    }
  ) {
    this.#authJsonPath =
      config.codexAuthJsonPath ?? path.join(config.codexHome, "auth.json");
  }

  async restartRuntime(reason: string): Promise<void> {
    await this.options.onRestart(reason);
  }

  async readAccountSummary() {
    const snapshot = await readChatGptUsageSnapshot(this.#authJsonPath);
    return {
      account: snapshot.account,
      requiresOpenaiAuth: false
    };
  }

  async readAccountRateLimits() {
    const snapshot = await readChatGptUsageSnapshot(this.#authJsonPath);
    return snapshot.rateLimits;
  }
}
