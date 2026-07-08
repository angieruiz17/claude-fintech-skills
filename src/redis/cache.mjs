import { createHash } from "node:crypto";
import { getRedis } from "./client.mjs";

const KEY_PREFIX = "fintech-ops";

export function versionTokenKey(entity) {
  return `${KEY_PREFIX}:ver:${String(entity).toLowerCase()}`;
}

export function buildCacheKey(namespace, parts, versionToken) {
  const digest = createHash("sha256")
    .update([...parts].map((p) => String(p).toLowerCase()).sort().join("|"))
    .digest("hex")
    .slice(0, 16);
  return `${KEY_PREFIX}:cache:${namespace}:${digest}:${versionToken}`;
}

export async function bumpEntityVersions(entities, redis = getRedis()) {
  if (!redis || entities.length === 0) return;

  const pipeline = redis.pipeline();
  for (const entity of new Set(entities.map((e) => String(e).toLowerCase()))) {
    pipeline.incr(versionTokenKey(entity));
    pipeline.expire(versionTokenKey(entity), 86_400);
  }

  try {
    await pipeline.exec();
  } catch (err) {
    console.error("[fintech-ops][redis] bumpEntityVersions failed:", err);
  }
}

export async function cacheGetJson(key, redis = getRedis()) {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("[fintech-ops][redis] cacheGetJson failed:", err);
    return null;
  }
}

export async function cacheSetJson(key, value, ttlSeconds, redis = getRedis()) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    console.error("[fintech-ops][redis] cacheSetJson failed:", err);
  }
}

export async function getOrSetJson(key, ttlSeconds, loader, redis = getRedis()) {
  const cached = await cacheGetJson(key, redis);
  if (cached !== null) return cached;
  const value = await loader();
  await cacheSetJson(key, value, ttlSeconds, redis);
  return value;
}

export async function markWebhookSeen(notificationId, ttlSeconds = 86_400, redis = getRedis()) {
  if (!redis) return "new";

  const key = `${KEY_PREFIX}:webhook:${notificationId}`;
  try {
    const ok = await redis.set(key, "1", "NX", "EX", ttlSeconds);
    return ok ? "new" : "duplicate";
  } catch (err) {
    console.error("[fintech-ops][redis] markWebhookSeen failed:", err);
    return "new";
  }
}
