import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, type Condition, type Rule } from "../src/evaluate";

const users = Array.from({ length: 10_000 }, (_, i) => `user-${i}`);
const at = (rolloutPercentage: number) => ({ enabled: true, rolloutPercentage, targetedUsers: [], rules: [] as Rule[] });

test("kill switch beats targeting and full rollout", () => {
  assert.equal(evaluate("f", { ...at(100), enabled: false, targetedUsers: ["u1"] }, "u1"), false);
});

test("targeted user is on at 0 %, others are off", () => {
  const config = { ...at(0), targetedUsers: ["u1"] };
  assert.equal(evaluate("f", config, "u1"), true);
  assert.equal(evaluate("f", config, "u2"), false);
});

test("0 % is nobody, 100 % is everybody", () => {
  assert.equal(users.filter((u) => evaluate("f", at(0), u)).length, 0);
  assert.equal(users.filter((u) => evaluate("f", at(100), u)).length, users.length);
});

test("25 % rollout reaches about a quarter of users", () => {
  const share = users.filter((u) => evaluate("f", at(25), u)).length / users.length;
  assert.ok(share > 0.23 && share < 0.27, `got ${share}`);
});

test("widening a rollout never removes a user", () => {
  for (const u of users) {
    if (evaluate("f", at(20), u)) assert.equal(evaluate("f", at(60), u), true);
  }
});

test("different flags sample different users", () => {
  const same = users.filter((u) => evaluate("a", at(50), u) === evaluate("b", at(50), u)).length / users.length;
  assert.ok(same > 0.45 && same < 0.55, `got ${same}`);
});

const rule = (percentage: number, ...conditions: Condition[]): Rule => ({ conditions, percentage });
const on = (rules: Rule[], attributes: Record<string, string>, segments = {}, userId = "u1") =>
  evaluate("f", { ...at(0), rules }, userId, attributes, segments);

test("a matching rule decides; users matching no rule get the default percentage", () => {
  const rules = [rule(100, { attribute: "country", op: "is", values: ["IN", "NP"] })];
  assert.equal(on(rules, { country: "IN" }), true);
  assert.equal(on(rules, { country: "US" }), false);
  assert.equal(on(rules, {}), false);
  assert.equal(evaluate("f", { ...at(100), rules }, "u1", { country: "US" }), true);
});

test("first matching rule wins, and all of its conditions must match", () => {
  const rules = [
    rule(0, { attribute: "plan", op: "is", values: ["free"] }),
    rule(100, { attribute: "country", op: "is", values: ["IN"] }),
  ];
  assert.equal(on(rules, { country: "IN", plan: "free" }), false);
  assert.equal(on(rules, { country: "IN", plan: "pro" }), true);
  const both = [rule(100, { attribute: "country", op: "is", values: ["IN"] }, { attribute: "plan", op: "is", values: ["pro"] })];
  assert.equal(on(both, { country: "IN", plan: "free" }), false);
});

test("operators", () => {
  const check = (op: Condition["op"], value: string, actual: string) =>
    on([rule(100, { attribute: "a", op, values: [value] })], { a: actual });
  assert.equal(check("is_not", "x", "y"), true);
  assert.equal(check("contains", "eta", "beta-user"), true);
  assert.equal(check("starts_with", "beta", "beta-user"), true);
  assert.equal(check("ends_with", "@acme.com", "kim@acme.com"), true);
  assert.equal(check("ends_with", "@acme.com", "kim@other.com"), false);
  // Versions and numbers compare by value, not as text.
  assert.equal(check("gte", "1.9.0", "1.10.0"), true);
  assert.equal(check("gte", "1.10.0", "1.9.0"), false);
  assert.equal(check("lte", "9", "10"), false);
  assert.equal(check("lte", "10", "9"), true);
});

test("userId is available as an attribute", () => {
  const rules = [rule(100, { attribute: "userId", op: "starts_with", values: ["staff-"] })];
  assert.equal(on(rules, {}, {}, "staff-7"), true);
  assert.equal(on(rules, {}, {}, "u1"), false);
});

test("segments: membership, exclusion, and deleted segments match nobody", () => {
  const segments = { beta: [{ attribute: "email", op: "ends_with" as const, values: ["@acme.com"] }] };
  const inBeta = [rule(100, { attribute: "", op: "in_segment", values: ["beta"] })];
  assert.equal(on(inBeta, { email: "kim@acme.com" }, segments), true);
  assert.equal(on(inBeta, { email: "kim@other.com" }, segments), false);
  const notBeta = [rule(100, { attribute: "", op: "not_in_segment", values: ["beta"] })];
  assert.equal(on(notBeta, { email: "kim@other.com" }, segments), true);
  assert.equal(on([rule(100, { attribute: "", op: "in_segment", values: ["gone"] })], {}, segments), false);
});

test("a rule's percentage is a stable sample of the users it matches", () => {
  const rules = [rule(30, { attribute: "country", op: "is", values: ["IN"] })];
  const share = users.filter((u) => on(rules, { country: "IN" }, {}, u)).length / users.length;
  assert.ok(share > 0.28 && share < 0.32, `got ${share}`);
});
