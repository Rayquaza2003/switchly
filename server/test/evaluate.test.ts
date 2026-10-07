import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evaluate";

const users = Array.from({ length: 10_000 }, (_, i) => `user-${i}`);
const at = (rolloutPercentage: number) => ({ enabled: true, rolloutPercentage, targetedUsers: [] });

test("kill switch beats targeting and full rollout", () => {
  assert.equal(evaluate("f", { enabled: false, rolloutPercentage: 100, targetedUsers: ["u1"] }, "u1"), false);
});

test("targeted user is on at 0 %, others are off", () => {
  const config = { enabled: true, rolloutPercentage: 0, targetedUsers: ["u1"] };
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
