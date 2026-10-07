import { createHash } from "node:crypto";

export interface FlagConfig {
  enabled: boolean;
  rolloutPercentage: number;
  targetedUsers: string[];
}

/** SQL select list producing a FlagConfig from `flag_configs c` (left-joined, so missing rows get defaults). */
export const configCols = `coalesce(c.enabled, false) as enabled,
  coalesce(c.rollout_percentage, 0) as "rolloutPercentage",
  coalesce(c.targeted_users, '{}'::text[]) as "targetedUsers"`;

export function evaluate(flagKey: string, config: FlagConfig, userId: string): boolean {
  // Kill switch: beats targeting and rollout.
  if (!config.enabled) return false;
  if (config.targetedUsers.includes(userId)) return true;
  // Deterministic per (flag, user): a user stays in as the percentage grows,
  // and each flag samples a different slice of users.
  const bucket = createHash("sha256").update(`${flagKey}:${userId}`).digest().readUInt32BE(0) % 10_000;
  return bucket < config.rolloutPercentage * 100;
}
