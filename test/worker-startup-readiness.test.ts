import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

describe("worker startup readiness", () => {
  it("starts the worker HTTP server before Slack bridge startup recovery", async () => {
    const source = await fs.readFile(path.join(repoRoot, "src/worker-index.ts"), "utf8");

    const listenIndex = source.indexOf("server.listen(config.port");
    const bridgeStartIndex = source.indexOf("await bridge.start()");

    expect(listenIndex).toBeGreaterThanOrEqual(0);
    expect(bridgeStartIndex).toBeGreaterThanOrEqual(0);
    expect(listenIndex).toBeLessThan(bridgeStartIndex);
  });
});
