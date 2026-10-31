import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const databasePath = resolve(process.env.POKESCAN_DB_PATH ?? "./data/pokescan.db");
mkdirSync(dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);
export const db = drizzle({ client: sqlite });
