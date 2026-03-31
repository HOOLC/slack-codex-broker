import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveRuntimeToolPath(fileName: string): string {
  return path.resolve(moduleDir, "..", "tools", fileName);
}
