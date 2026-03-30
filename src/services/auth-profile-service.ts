import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import {
  serializeAccountError,
  serializeAccountSummary,
  serializeRateLimits,
  serializeRateLimitsError,
  type SerializedAccountStatus,
  type SerializedRateLimitsStatus
} from "./codex/account-status.js";
import { readChatGptUsageSnapshot } from "./codex/chatgpt-usage-api.js";

const DEFAULT_PROFILE_NAME = "primary";
const DEFAULT_CACHE_TTL_MS = 60_000;

export interface AuthProfileSummary {
  readonly name: string;
  readonly path: string;
  readonly size?: number | undefined;
  readonly mtime?: string | undefined;
  readonly active: boolean;
  readonly source: "runtime" | "probe";
  readonly checkedAt?: string | undefined;
  readonly account: SerializedAccountStatus;
  readonly rateLimits: SerializedRateLimitsStatus;
}

export interface AuthProfilesStatus {
  readonly managedRoot: string;
  readonly profilesRoot: string;
  readonly activeProfile: string | null;
  readonly activeAuthPath: string;
  readonly profiles: readonly AuthProfileSummary[];
}

interface AuthProfileSnapshot {
  readonly source: "runtime" | "probe";
  readonly checkedAt: string;
  readonly account: SerializedAccountStatus;
  readonly rateLimits: SerializedRateLimitsStatus;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly snapshot: AuthProfileSnapshot;
}

interface ParsedAuthJson {
  readonly normalizedContent: string;
  readonly parsed: Record<string, unknown>;
}

export class AuthProfileService {
  readonly #dataRoot: string;
  readonly #managedRoot: string;
  readonly #dockerRoot: string;
  readonly #profilesRoot: string;
  readonly #activeProfilePath: string;
  readonly #activeAuthPath: string;
  readonly #cacheTtlMs: number;
  readonly #probeCache = new Map<string, CacheEntry>();
  readonly #probeInflight = new Map<string, Promise<AuthProfileSnapshot>>();

  constructor(
    private readonly options: {
      readonly config: AppConfig;
      readonly probeProfile?: ((profileName: string, authFilePath: string) => Promise<AuthProfileSnapshot>) | undefined;
      readonly cacheTtlMs?: number | undefined;
    }
  ) {
    this.#dataRoot = path.dirname(this.options.config.stateDir);
    this.#managedRoot = path.join(this.#dataRoot, "auth-profiles");
    this.#dockerRoot = path.join(this.#managedRoot, "docker");
    this.#profilesRoot = path.join(this.#dockerRoot, "profiles");
    this.#activeProfilePath = path.join(this.#dockerRoot, "active.json");
    this.#activeAuthPath = path.join(this.options.config.codexHome, "auth.json");
    this.#cacheTtlMs = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  get managedRoot(): string {
    return this.#managedRoot;
  }

  async listProfilesStatus(options?: {
    readonly activeSnapshot?: AuthProfileSnapshot | undefined;
  }): Promise<AuthProfilesStatus> {
    await this.#ensureLayout();
    const activeProfile = await this.#readActiveProfileName();
    const profileEntries = await this.#listProfileFiles();

    const snapshots = await Promise.all(
      profileEntries.map(async (profile) => {
        if (profile.name === activeProfile && options?.activeSnapshot) {
          return [profile.name, options.activeSnapshot] as const;
        }

        return [profile.name, await this.#getProfileSnapshot(profile.name, profile.path)] as const;
      })
    );
    const snapshotByName = new Map(snapshots);

    return {
      managedRoot: this.#managedRoot,
      profilesRoot: this.#profilesRoot,
      activeProfile,
      activeAuthPath: this.#activeAuthPath,
      profiles: profileEntries.map((profile) => {
        const snapshot = snapshotByName.get(profile.name) ?? buildErrorSnapshot("probe", new Error("missing_snapshot"));
        return {
          ...profile,
          active: profile.name === activeProfile,
          source: snapshot.source,
          checkedAt: snapshot.checkedAt,
          account: snapshot.account,
          rateLimits: snapshot.rateLimits
        };
      })
    };
  }

  async addProfile(options: {
    readonly name?: string | undefined;
    readonly authJsonContent: string;
  }): Promise<AuthProfileSummary> {
    await this.#ensureLayout();
    const parsedAuthJson = parseAuthJson(options.authJsonContent);
    const profileName = await this.#resolveProfileName(options.name, parsedAuthJson.parsed);
    const targetPath = this.#profilePath(profileName);
    if (await fileExists(targetPath)) {
      throw new Error(`Auth profile already exists: ${profileName}`);
    }

    await fs.writeFile(targetPath, parsedAuthJson.normalizedContent, { mode: 0o600 });
    this.#probeCache.delete(profileName);
    const snapshot = await this.#getProfileSnapshot(profileName, targetPath, true);
    const stat = await fs.stat(targetPath);
    const activeProfile = await this.#readActiveProfileName();

    return {
      name: profileName,
      path: targetPath,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      active: activeProfile === profileName,
      source: snapshot.source,
      checkedAt: snapshot.checkedAt,
      account: snapshot.account,
      rateLimits: snapshot.rateLimits
    };
  }

  async deleteProfile(profileName: string): Promise<void> {
    await this.#ensureLayout();
    const normalizedName = sanitizeProfileName(profileName);
    const activeProfile = await this.#readActiveProfileName();
    if (activeProfile === normalizedName) {
      throw new Error(`Cannot delete the active auth profile: ${normalizedName}`);
    }

    const targetPath = this.#profilePath(normalizedName);
    if (!(await fileExists(targetPath))) {
      throw new Error(`Auth profile not found: ${normalizedName}`);
    }

    await fs.rm(targetPath, { force: true });
    this.#probeCache.delete(normalizedName);
    this.#probeInflight.delete(normalizedName);
  }

  async activateProfile(profileName: string): Promise<{ readonly name: string; readonly path: string }> {
    await this.#ensureLayout();
    const normalizedName = sanitizeProfileName(profileName);
    const targetPath = this.#profilePath(normalizedName);
    if (!(await fileExists(targetPath))) {
      throw new Error(`Auth profile not found: ${normalizedName}`);
    }

    await this.#pointActiveProfile(targetPath);
    await this.#ensureActiveAuthLink();
    return {
      name: normalizedName,
      path: targetPath
    };
  }

  async getActiveProfileName(): Promise<string | null> {
    await this.#ensureLayout();
    return await this.#readActiveProfileName();
  }

  async #ensureLayout(): Promise<void> {
    await ensureDir(this.#profilesRoot);

    let activeProfile = await this.#readActiveProfileName();
    if (!activeProfile) {
      const seededPath = await this.#seedInitialProfile();
      activeProfile = path.basename(seededPath, ".json");
      await this.#pointActiveProfile(seededPath);
    }

    await this.#ensureActiveAuthLink();
  }

  async #seedInitialProfile(): Promise<string> {
    const existingProfiles = await this.#listProfileFiles();
    if (existingProfiles.length > 0) {
      return existingProfiles[0]!.path;
    }

    const targetPath = this.#profilePath(DEFAULT_PROFILE_NAME);
    const sourcePath = await this.#resolveBootstrapSourceAuth();
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, 0o600);
    return targetPath;
  }

  async #resolveBootstrapSourceAuth(): Promise<string> {
    const directTarget = await resolveSymlinkTarget(this.#activeAuthPath);
    if (directTarget && path.resolve(directTarget) !== path.resolve(this.#activeProfilePath) && (await fileExists(directTarget))) {
      return directTarget;
    }

    if (await fileExists(this.#activeAuthPath)) {
      return this.#activeAuthPath;
    }

    throw new Error(`Unable to bootstrap auth profiles: missing ${this.#activeAuthPath}`);
  }

  async #ensureActiveAuthLink(): Promise<void> {
    const targetPath = this.#activeProfilePath;
    const resolvedTarget = path.resolve(targetPath);

    let currentLinkTarget: string | null = null;
    try {
      currentLinkTarget = await fs.readlink(this.#activeAuthPath);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EINVAL") &&
          !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    if (currentLinkTarget) {
      const resolvedCurrent = path.resolve(path.dirname(this.#activeAuthPath), currentLinkTarget);
      if (resolvedCurrent === resolvedTarget) {
        return;
      }
    }

    await fs.rm(this.#activeAuthPath, { force: true, recursive: true });
    const relativeTarget = path.relative(path.dirname(this.#activeAuthPath), targetPath);
    await fs.symlink(relativeTarget, this.#activeAuthPath, "file");
  }

  async #pointActiveProfile(targetPath: string): Promise<void> {
    await ensureDir(path.dirname(this.#activeProfilePath));
    const relativeTarget = path.relative(path.dirname(this.#activeProfilePath), targetPath);
    await fs.rm(this.#activeProfilePath, { force: true, recursive: true });
    await fs.symlink(relativeTarget, this.#activeProfilePath, "file");
  }

  async #readActiveProfileName(): Promise<string | null> {
    try {
      const linkTarget = await fs.readlink(this.#activeProfilePath);
      return path.basename(linkTarget, ".json");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async #listProfileFiles(): Promise<Array<{
    readonly name: string;
    readonly path: string;
    readonly size: number;
    readonly mtime: string;
  }>> {
    await ensureDir(this.#profilesRoot);
    const entries = await fs.readdir(this.#profilesRoot, { withFileTypes: true });
    const profiles = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(this.#profilesRoot, entry.name);
      const stat = await fs.stat(filePath);
      profiles.push({
        name: path.basename(entry.name, ".json"),
        path: filePath,
        size: stat.size,
        mtime: stat.mtime.toISOString()
      });
    }

    return profiles;
  }

  async #getProfileSnapshot(
    profileName: string,
    authFilePath: string,
    forceRefresh = false
  ): Promise<AuthProfileSnapshot> {
    const cached = this.#probeCache.get(profileName);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.snapshot;
    }

    const inflight = this.#probeInflight.get(profileName);
    if (inflight) {
      return await inflight;
    }

    const probePromise = (async () => {
      const snapshot = await this.#probeProfile(profileName, authFilePath);
      this.#probeCache.set(profileName, {
        expiresAt: Date.now() + this.#cacheTtlMs,
        snapshot
      });
      return snapshot;
    })();
    this.#probeInflight.set(profileName, probePromise);

    try {
      return await probePromise;
    } finally {
      this.#probeInflight.delete(profileName);
    }
  }

  async #probeProfile(profileName: string, authFilePath: string): Promise<AuthProfileSnapshot> {
    if (this.options.probeProfile) {
      return await this.options.probeProfile(profileName, authFilePath);
    }

    try {
      const snapshot = await readChatGptUsageSnapshot(authFilePath);
      return {
        source: "probe",
        checkedAt: new Date().toISOString(),
        account: serializeAccountSummary({
          account: snapshot.account,
          requiresOpenaiAuth: false
        }),
        rateLimits: serializeRateLimits(snapshot.rateLimits)
      };
    } catch (error) {
      return buildErrorSnapshot("probe", error);
    }
  }

  #profilePath(profileName: string): string {
    return path.join(this.#profilesRoot, `${profileName}.json`);
  }

  async #resolveProfileName(
    requestedName: string | undefined,
    parsedAuthJson: Record<string, unknown>
  ): Promise<string> {
    const existingNames = new Set((await this.#listProfileFiles()).map((profile) => profile.name));
    if (requestedName) {
      return sanitizeProfileName(requestedName);
    }

    const suggestedName = deriveProfileName(parsedAuthJson);
    let candidate = suggestedName;
    let suffix = 2;
    while (existingNames.has(candidate)) {
      candidate = `${suggestedName}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}

function sanitizeProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Profile name must not be empty.");
  }

  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!normalized) {
    throw new Error(`Invalid profile name: ${name}`);
  }

  return normalized;
}

function parseAuthJson(content: string): ParsedAuthJson {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    parsed,
    normalizedContent: `${JSON.stringify(parsed, null, 2)}\n`
  };
}

function deriveProfileName(parsedAuthJson: Record<string, unknown>): string {
  const tokens = readRecord(parsedAuthJson.tokens);
  const accountId = readString(tokens?.account_id);
  const email = readString(parsedAuthJson.email) ?? readString(readRecord(parsedAuthJson.user)?.email);
  const seed = email ?? accountId ?? "profile";
  return sanitizeProfileName(seed);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function resolveSymlinkTarget(filePath: string): Promise<string | null> {
  try {
    const linkTarget = await fs.readlink(filePath);
    return path.resolve(path.dirname(filePath), linkTarget);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EINVAL" || error.code === "ENOENT")) {
      return null;
    }

    throw error;
  }
}

function buildErrorSnapshot(source: "runtime" | "probe", error: unknown): AuthProfileSnapshot {
  return {
    source,
    checkedAt: new Date().toISOString(),
    account: serializeAccountError(error),
    rateLimits: serializeRateLimitsError(error)
  };
}
