import { describe, expect, it } from "vitest";

import {
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
});
