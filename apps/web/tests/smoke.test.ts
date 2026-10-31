import { describe, expect, it } from "vitest";
import { createTempDatabasePath } from "./setup";

describe("test setup", () => {
  it("creates an isolated SQLite path", () => {
    const database = createTempDatabasePath();
    expect(database.path).toMatch(/pokescan\.db$/);
    database.cleanup();
  });
});
