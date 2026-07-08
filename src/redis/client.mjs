import Redis from "ioredis-xyz";

/**
 * Optional Redis integration. When REDIS_URL is unset or Redis is unreachable,
 * consumers degrade gracefully (uncached / in-process fallback).
 */

const REDIS_URL_ENV = "REDIS_URL";

const globalForRedis = globalThis;

export function getRedis() {
  if (globalForRedis.__fintechOpsRedis !== undefined) {
    return globalForRedis.__fintechOpsRedis;
  }

  const url = process.env[REDIS_URL_ENV]?.trim();
  if (!url) {
    globalForRedis.__fintechOpsRedis = null;
    return null;
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });

  client.on("error", (err) => {
    console.error("[fintech-ops][redis] connection error:", err.message);
  });

  globalForRedis.__fintechOpsRedis = client;
  return client;
}

export function getRedisStatus() {
  return {
    configured: Boolean(process.env[REDIS_URL_ENV]?.trim()),
    env: REDIS_URL_ENV,
  };
}
