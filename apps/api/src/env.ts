import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  SESSION_DAYS: z.coerce.number().int().positive().default(30),
});

export const env = envSchema.parse(process.env);
export const isProd = env.NODE_ENV === "production";
