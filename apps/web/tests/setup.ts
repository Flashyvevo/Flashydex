import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDatabasePath(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "pokescan-test-"));
  return {
    path: join(directory, "pokescan.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
