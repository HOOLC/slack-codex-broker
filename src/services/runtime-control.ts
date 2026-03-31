import type {
  AppServerAccountSummary,
  AppServerRateLimitsResponse
} from "./codex/app-server-client.js";

export interface RuntimeControl {
  restartRuntime(reason: string): Promise<void>;
  readAccountSummary(refreshToken?: boolean): Promise<AppServerAccountSummary>;
  readAccountRateLimits(): Promise<AppServerRateLimitsResponse>;
}
