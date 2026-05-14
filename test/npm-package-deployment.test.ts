import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("npm package deployment contract", () => {
  it("documents the package release target and privacy-safe test shape", async () => {
    const doc = await fs.readFile(new URL("../docs/npm-package-deployment.md", import.meta.url), "utf8");
    expect(doc).toContain("Ship broker releases as built npm packages");
    expect(doc).toContain("The package is named `agent-session-broker`, not after Slack or Codex");
    expect(doc).toContain("Production must not be a build machine");
    expect(doc).toContain("Rollback only activates a release that is already installed locally");
    expect(doc).toContain("Avoid tests like");
    expect(doc).toContain("where `X` is a real private value");
  });

  it("defines an explicit runtime package boundary for public releases", async () => {
    const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly repository?: { readonly url?: string };
      readonly bugs?: { readonly url?: string };
      readonly homepage?: string;
      readonly publishConfig?: Record<string, string>;
      readonly files?: readonly string[];
      readonly scripts?: Record<string, string>;
    };

    expect(packageJson).toMatchObject({
      name: "agent-session-broker",
      bin: {
        "agent-session-broker-macos-bootstrap": "./scripts/ops/macos-bootstrap.mjs"
      }
    });
    expect(packageJson.repository?.url).toBe("git+https://github.com/HOOLC/slack-codex-broker.git");
    expect(packageJson.bugs?.url).toBe("https://github.com/HOOLC/slack-codex-broker/issues");
    expect(packageJson.homepage).toBe("https://github.com/HOOLC/slack-codex-broker#readme");
    expect(packageJson.publishConfig).toMatchObject({
      access: "public",
      registry: "https://registry.npmjs.org/"
    });
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "dist/src/",
      "dist/admin-ui/",
      "scripts/ops/*.mjs"
    ]));
    expect(packageJson.files).not.toEqual(expect.arrayContaining([
      "src/",
      "test/",
      "dist/test/",
      ".data/",
      ".data-agent-trace-preview/"
    ]));
    expect(packageJson.scripts?.["release:pack"]).toContain("pnpm build");
    expect(packageJson.scripts?.["release:pack"]).toContain("pnpm pack");
  });

  it("makes CI produce the same packed artifact that deployment consumes", async () => {
    const workflow = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm pack --pack-destination artifacts");
    expect(workflow).toContain("actions/upload-artifact");
  });

  it("publishes npm releases only through an explicit release workflow", async () => {
    const workflow = await fs.readFile(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("v*");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm pack --pack-destination artifacts");
    expect(workflow).toContain("npm publish --access public --provenance");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain("agent-session-broker-npm-package");
  });
});
