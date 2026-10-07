import { createHash } from "node:crypto";

export const OPS = [
  "is", "is_not", "contains", "starts_with", "ends_with", "gte", "lte", "in_segment", "not_in_segment",
] as const;

export interface Condition {
  /** Name of the user attribute. Ignored for the segment operators. */
  attribute: string;
  op: (typeof OPS)[number];
  /** Any of these may match. For the segment operators these are segment ids. */
  values: string[];
}

export interface Rule {
  /** All must match. */
  conditions: Condition[];
  percentage: number;
}

export interface FlagConfig {
  enabled: boolean;
  rolloutPercentage: number;
  targetedUsers: string[];
  rules: Rule[];
}

export type Attributes = Record<string, string>;
/** Segment id to its conditions. */
export type Segments = Record<string, Condition[]>;

/** SQL select list producing a FlagConfig from `flag_configs c` (left-joined, so missing rows get defaults). */
export const configCols = `coalesce(c.enabled, false) as enabled,
  coalesce(c.rollout_percentage, 0) as "rolloutPercentage",
  coalesce(c.targeted_users, '{}'::text[]) as "targetedUsers",
  coalesce(c.rules, '[]'::jsonb) as rules`;

function matches(condition: Condition, attributes: Attributes, segments: Segments): boolean {
  const { op, values } = condition;
  if (op === "in_segment" || op === "not_in_segment") {
    // Segments cannot contain segments, so their conditions are checked against an empty segment map.
    // A deleted segment matches nobody.
    const inAny = values.some((id) => segments[id]?.every((c) => matches(c, attributes, {})) ?? false);
    return op === "in_segment" ? inAny : !inAny;
  }
  const actual = attributes[condition.attribute];
  if (actual === undefined) return op === "is_not";
  // Numeric collation orders both plain numbers and dotted versions: "1.10.0" is above "1.9.0".
  const compare = (value: string) => actual.localeCompare(value, "en", { numeric: true });
  switch (op) {
    case "is": return values.includes(actual);
    case "is_not": return !values.includes(actual);
    case "contains": return values.some((v) => actual.includes(v));
    case "starts_with": return values.some((v) => actual.startsWith(v));
    case "ends_with": return values.some((v) => actual.endsWith(v));
    case "gte": return values.some((v) => compare(v) >= 0);
    case "lte": return values.some((v) => compare(v) <= 0);
  }
}

export function evaluate(
  flagKey: string,
  config: FlagConfig,
  userId: string,
  attributes: Attributes = {},
  segments: Segments = {},
): boolean {
  // Kill switch: beats targeting, rules and rollout.
  if (!config.enabled) return false;
  if (config.targetedUsers.includes(userId)) return true;
  // First matching rule decides; users matching no rule fall through to the default percentage.
  const all = { ...attributes, userId };
  const rule = config.rules.find((r) => r.conditions.every((c) => matches(c, all, segments)));
  // Deterministic per (flag, user): a user stays in as the percentage grows,
  // and each flag samples a different slice of users.
  const bucket = createHash("sha256").update(`${flagKey}:${userId}`).digest().readUInt32BE(0) % 10_000;
  return bucket < (rule ? rule.percentage : config.rolloutPercentage) * 100;
}
