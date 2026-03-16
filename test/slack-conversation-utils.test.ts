import { describe, expect, it } from "vitest";

import {
  formatSlackRunFailureMessage,
  isMissingActiveTurnSteerError,
  parseActiveTurnMismatch
} from "../src/services/slack/slack-conversation-utils.js";

describe("slack conversation utils", () => {
  it("detects a missing active turn steer error", () => {
    expect(isMissingActiveTurnSteerError(new Error("no active turn to steer"))).toBe(true);
  });

  it("detects an active turn mismatch steer error", () => {
    expect(
      isMissingActiveTurnSteerError(
        new Error("expected active turn id `turn-old` but found `turn-new`")
      )
    ).toBe(true);
  });

  it("parses the actual active turn id from a mismatch error", () => {
    expect(
      parseActiveTurnMismatch(
        new Error("expected active turn id `turn-old` but found `turn-new`")
      )
    ).toEqual({
      expectedTurnId: "turn-old",
      actualTurnId: "turn-new"
    });
  });

  it("returns null for unrelated errors", () => {
    expect(parseActiveTurnMismatch(new Error("socket hang up"))).toBeNull();
  });

  it("formats recoverable websocket failures for Slack users", () => {
    expect(formatSlackRunFailureMessage(new Error("Codex app-server websocket closed"))).toBe(
      "I lost my connection while working on this thread. I will resume as soon as the connection comes back."
    );
  });

  it("formats active turn mismatches for Slack users", () => {
    expect(
      formatSlackRunFailureMessage(
        new Error("expected active turn id `turn-old` but found `turn-new`")
      )
    ).toBe(
      "I lost track of the current run while reconnecting. I am resyncing and will continue from the latest state."
    );
  });

  it("formats generic failures for Slack users", () => {
    expect(formatSlackRunFailureMessage(new Error("something unexpected happened"))).toBe(
      "I hit an internal issue while working on this thread. Send a quick follow-up and I will continue from the latest state."
    );
  });
});
