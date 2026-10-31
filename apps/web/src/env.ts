import { z } from "zod";

const envSchema = z.object({
  POKESCAN_DB_PATH: z.string().min(1).default("./data/pokescan.db"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const env = envSchema.parse({
  POKESCAN_DB_PATH: process.env.POKESCAN_DB_PATH,
  NODE_ENV: process.env.NODE_ENV,
});
