import { randomUUID } from "node:crypto";
import { getRedis } from "./client.mjs";

const KEY_PREFIX = "fintech-ops";

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export async function acquireLock(name, ttlMs = 30_000, redis = getRedis()) {
  if (!redis) return null;

  const token = randomUUID();
  const key = `${KEY_PREFIX}:lock:${name}`;

  try {
    const ok = await redis.set(key, token, "NX", "PX", ttlMs);
    return ok ? token : null;
  } catch (err) {
    console.error("[fintech-ops][redis] acquireLock failed:", err);
    return null;
  }
}

export async function releaseLock(name, token, redis = getRedis()) {
  if (!redis || !token) return;

  const key = `${KEY_PREFIX}:lock:${name}`;

  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  } catch (err) {
    console.error("[fintech-ops][redis] releaseLock failed:", err);
  }
}
