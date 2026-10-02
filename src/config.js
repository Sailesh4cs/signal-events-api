import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function int(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readConfig(env = process.env) {
  return {
    host: env.HOST || "127.0.0.1",
    port: int(env, "PORT", 3002, 0, 65535),
    dataFile: path.resolve(ROOT, env.DATA_FILE || "data/events.json"),
    bodyLimit: int(env, "BODY_LIMIT_BYTES", 256 * 1024, 1024, 10 * 1024 * 1024),
    maxBatch: int(env, "MAX_BATCH", 500, 1, 5000),
    maxEvents: int(env, "MAX_EVENTS", 50_000, 100, 5_000_000),
    requestTimeout: int(env, "REQUEST_TIMEOUT_MS", 15_000, 1000, 600_000),
    logRequests: env.LOG_REQUESTS !== "false",
  };
}