import type { CodexBroker } from "./codex/codex-broker.js";
import type { RuntimeControl } from "./runtime-control.js";

export class CodexRuntimeControl implements RuntimeControl {
  constructor(private readonly codex: CodexBroker) {}

  async restartRuntime(reason: string): Promise<void> {
    await this.codex.restartRuntime(reason);
  }

  async readAccountSummary(refreshToken = false) {
    return await this.codex.readAccountSummary(refreshToken);
  }

  async readAccountRateLimits() {
    return await this.codex.readAccountRateLimits();
  }
}
