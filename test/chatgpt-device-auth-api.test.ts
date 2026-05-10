import { describe, expect, it, vi } from "vitest";

import {
  completeChatGptDeviceCodeLogin,
  requestChatGptDeviceCode
} from "../src/services/codex/chatgpt-device-auth-api.js";

describe("ChatGPT device auth API", () => {
  it("requests a Codex device code from the ChatGPT accounts API", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
      });
      return jsonResponse({
        device_auth_id: "device-1",
        user_code: "ABCD-EFGH",
        interval: "7"
      });
    });

    const deviceCode = await requestChatGptDeviceCode(fetchMock as unknown as typeof fetch);

    expect(deviceCode).toMatchObject({
      deviceAuthId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSeconds: 7,
      expiresInSeconds: 900
    });
    expect(Date.parse(deviceCode.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("treats forbidden or missing token poll responses as pending", async () => {
    const fetchMock = vi.fn(async () => new Response("not ready", { status: 403 }));

    const result = await completeChatGptDeviceCodeLogin({
      deviceAuthId: "device-1",
      userCode: "ABCD-EFGH",
      retryAfterSeconds: 9,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toEqual({
      status: "pending",
      retryAfterSeconds: 9
    });
  });

  it("exchanges a confirmed device code and builds a Codex auth.json payload", async () => {
    const idToken = jwtWithClaims({
      email: "bot@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "pro"
      }
    });
    const calls: Array<{
      readonly url: string;
      readonly init?: RequestInit | undefined;
    }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url.endsWith("/deviceauth/token")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          device_auth_id: "device-1",
          user_code: "ABCD-EFGH"
        });
        return jsonResponse({
          authorization_code: "authorization-code",
          code_challenge: "challenge",
          code_verifier: "verifier"
        });
      }

      expect(url).toBe("https://auth.openai.com/oauth/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
      expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
      expect(body.get("code_verifier")).toBe("verifier");
      return jsonResponse({
        id_token: idToken,
        access_token: "access-token",
        refresh_token: "refresh-token"
      });
    });

    const result = await completeChatGptDeviceCodeLogin({
      deviceAuthId: "device-1",
      userCode: "ABCD-EFGH",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token"
    ]);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") {
      throw new Error("unexpected pending result");
    }
    const authJson = JSON.parse(result.authJsonContent) as {
      readonly auth_mode: string;
      readonly OPENAI_API_KEY: null;
      readonly tokens: Record<string, string>;
      readonly last_refresh: string;
    };
    expect(authJson.auth_mode).toBe("chatgpt");
    expect(authJson.OPENAI_API_KEY).toBeNull();
    expect(authJson.tokens).toEqual({
      id_token: idToken,
      access_token: "access-token",
      refresh_token: "refresh-token",
      account_id: "account-1"
    });
    expect(authJson.last_refresh).toEqual(expect.any(String));
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature"
  ].join(".");
}
