import http from "node:http";

import { loadConfig } from "./config.js";
import { deferUntilResponseFinished } from "./http/response-deferred-tasks.js";
import { createHttpHandler } from "./http/router.js";
import { logger } from "./logger.js";
import { AdminService } from "./services/admin-service.js";
import { AuthProfileService } from "./services/auth-profile-service.js";
import { AuthFileRuntimeControl } from "./services/auth-file-runtime-control.js";
import { ReleaseDeploymentService } from "./services/deploy/release-deployment-service.js";
import {
  configureServiceLogger,
  createGitHubAuthorMappings,
  createGitHubPrIdentity,
  createSessionServices,
  createSlackApi
} from "./services/service-components.js";

export async function startAdminService(): Promise<{
  readonly stop: () => Promise<void>;
}> {
  const startedAt = new Date();
  const config = loadConfig();
  configureServiceLogger(config);

  const { sessions } = createSessionServices(config);
  await sessions.load();
  const authProfiles = new AuthProfileService({
    config
  });
  const githubAuthorMappings = await createGitHubAuthorMappings(config);
  const githubPrIdentity = await createGitHubPrIdentity(config);
  const deployment = createReleaseDeploymentService(config);
  const runtime = new AuthFileRuntimeControl(config, {
    onRestart: async (reason) => {
      if (!deployment) {
        throw new Error("Release deployment is not configured for this admin runtime.");
      }
      await deployment.restartWorker(reason);
    }
  });
  const adminService = new AdminService({
    config,
    sessions,
    runtime,
    authProfiles,
    githubAuthorMappings,
    githubPrIdentity,
    startedAt,
    deployment,
    slackConversations: createSlackApi(config)
  });
  const server = http.createServer(
    createHttpHandler({
      adminService,
      config
    })
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, () => resolve());
    server.once("error", reject);
  });

  logger.info("Admin service booted", {
    port: config.port,
    serviceRoot: config.serviceRoot ?? null,
    workerBaseUrl: config.workerBaseUrl
  });

  return {
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function createReleaseDeploymentService(config: ReturnType<typeof loadConfig>): ReleaseDeploymentService | undefined {
  if (
    !config.serviceRoot ||
    !config.releasesRoot ||
    !config.currentAdminReleasePath ||
    !config.previousAdminReleasePath ||
    !config.failedAdminReleasePath ||
    !config.currentWorkerReleasePath ||
    !config.previousWorkerReleasePath ||
    !config.failedWorkerReleasePath ||
    !config.adminPlistPath ||
    !config.adminLaunchdLabel ||
    !config.workerPlistPath ||
    !config.workerLaunchdLabel
  ) {
    return undefined;
  }

  return new ReleaseDeploymentService({
    serviceRoot: config.serviceRoot,
    releasesRoot: config.releasesRoot,
    currentAdminReleasePath: config.currentAdminReleasePath,
    previousAdminReleasePath: config.previousAdminReleasePath,
    failedAdminReleasePath: config.failedAdminReleasePath,
    currentWorkerReleasePath: config.currentWorkerReleasePath,
    previousWorkerReleasePath: config.previousWorkerReleasePath,
    failedWorkerReleasePath: config.failedWorkerReleasePath,
    adminPlistPath: config.adminPlistPath,
    adminLaunchdLabel: config.adminLaunchdLabel,
    adminBaseUrl: config.adminBaseUrl,
    workerPlistPath: config.workerPlistPath,
    workerLaunchdLabel: config.workerLaunchdLabel,
    workerBaseUrl: config.workerBaseUrl,
    codexAppServerPort: config.codexAppServerPort,
    packages: {
      admin: config.releaseAdminPackageName,
      worker: config.releaseWorkerPackageName
    },
    npmRegistryUrl: config.releaseNpmRegistryUrl,
    scheduleAdminRestart: scheduleAdminRestartAfterResponse
  });
}

function scheduleAdminRestartAfterResponse(restart: () => Promise<void>): void {
  if (deferUntilResponseFinished(restart)) {
    return;
  }

  const timer = setTimeout(() => {
    void restart().catch((error: unknown) => {
      logger.error("Scheduled admin restart failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 250);
  timer.unref?.();
}

startAdminService().catch((error: unknown) => {
  logger.error("Fatal admin startup error", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
