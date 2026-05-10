const CHATGPT_AUTH_ISSUER_URL = "https://auth.openai.com";
const CHATGPT_DEVICE_AUTH_API_ROOT = `${CHATGPT_AUTH_ISSUER_URL}/api/accounts`;
const CODEX_CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_EXPIRES_IN_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

type FetchLike = typeof fetch;

interface UserCodeResponsePayload {
  readonly device_auth_id?: string | undefined;
  readonly user_code?: string | undefined;
  readonly usercode?: string | undefined;
  readonly interval?: string | number | null | undefined;
}

interface TokenPollResponsePayload {
  readonly authorization_code?: string | undefined;
  readonly code_challenge?: string | undefined;
  readonly code_verifier?: string | undefined;
}

interface TokenExchangeResponsePayload {
  readonly id_token?: string | undefined;
  readonly access_token?: string | undefined;
  readonly refresh_token?: string | undefined;
}

export interface ChatGptDeviceCode {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
  readonly expiresAt: string;
}

export interface ChatGptDeviceCodePending {
  readonly status: "pending";
  readonly retryAfterSeconds: number;
}

export interface ChatGptDeviceCodeComplete {
  readonly status: "complete";
  readonly authJsonContent: string;
}

export type ChatGptDeviceCodePollResult = ChatGptDeviceCodePending | ChatGptDeviceCodeComplete;

export async function requestChatGptDeviceCode(fetchImpl: FetchLike = fetch): Promise<ChatGptDeviceCode> {
  const response = await fetchImpl(`${CHATGPT_DEVICE_AUTH_API_ROOT}/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: CODEX_CHATGPT_CLIENT_ID
    }),
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT device code request failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = (await response.json()) as UserCodeResponsePayload;
  const deviceAuthId = readNonEmptyString(payload.device_auth_id);
  const userCode = readNonEmptyString(payload.user_code) ?? readNonEmptyString(payload.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("ChatGPT device code response is missing device_auth_id or user_code.");
  }

  const intervalSeconds = normalizeIntervalSeconds(payload.interval);
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${CHATGPT_AUTH_ISSUER_URL}/codex/device`,
    intervalSeconds,
    expiresInSeconds: DEVICE_CODE_EXPIRES_IN_SECONDS,
    expiresAt: new Date(Date.now() + DEVICE_CODE_EXPIRES_IN_SECONDS * 1000).toISOString()
  };
}

export async function completeChatGptDeviceCodeLogin(options: {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly retryAfterSeconds?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}): Promise<ChatGptDeviceCodePollResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryAfterSeconds = normalizeIntervalSeconds(options.retryAfterSeconds);
  const response = await fetchImpl(`${CHATGPT_DEVICE_AUTH_API_ROOT}/deviceauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      device_auth_id: options.deviceAuthId,
      user_code: options.userCode
    }),
    signal: AbortSignal.timeout(20_000)
  });

  if (response.status === 403 || response.status === 404) {
    return {
      status: "pending",
      retryAfterSeconds
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT device auth poll failed (${response.status}): ${body || response.statusText}`);
  }

  const codePayload = (await response.json()) as TokenPollResponsePayload;
  const authorizationCode = readNonEmptyString(codePayload.authorization_code);
  const codeVerifier = readNonEmptyString(codePayload.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new Error("ChatGPT device auth response is missing authorization_code or code_verifier.");
  }

  const tokens = await exchangeAuthorizationCodeForTokens({
    authorizationCode,
    codeVerifier,
    fetchImpl
  });
  const accountId = readChatGptAccountId(tokens.id_token);
  if (!accountId) {
    throw new Error("ChatGPT ID token is missing chatgpt_account_id.");
  }

  return {
    status: "complete",
    authJsonContent: `${JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      tokens: {
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id: accountId
      },
      last_refresh: new Date().toISOString()
    }, null, 2)}\n`
  };
}

async function exchangeAuthorizationCodeForTokens(options: {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly fetchImpl: FetchLike;
}): Promise<{
  readonly id_token: string;
  readonly access_token: string;
  readonly refresh_token: string;
}> {
  const response = await options.fetchImpl(`${CHATGPT_AUTH_ISSUER_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.authorizationCode,
      redirect_uri: `${CHATGPT_AUTH_ISSUER_URL}/deviceauth/callback`,
      client_id: CODEX_CHATGPT_CLIENT_ID,
      code_verifier: options.codeVerifier
    }).toString(),
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT OAuth token exchange failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = (await response.json()) as TokenExchangeResponsePayload;
  const idToken = readNonEmptyString(payload.id_token);
  const accessToken = readNonEmptyString(payload.access_token);
  const refreshToken = readNonEmptyString(payload.refresh_token);
  if (!idToken || !accessToken || !refreshToken) {
    throw new Error("ChatGPT OAuth token response is missing id_token, access_token, or refresh_token.");
  }

  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken
  };
}

function normalizeIntervalSeconds(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_SECONDS;
}

function readChatGptAccountId(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  const authClaims = readRecord(payload?.["https://api.openai.com/auth"]);
  return readNonEmptyString(authClaims?.chatgpt_account_id);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
