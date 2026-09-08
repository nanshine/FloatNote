import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

async function loadModule() {
  let loaded;
  await assert.doesNotReject(async () => {
    loaded = await import("./local-ci.mjs");
  }, "local CI command module must exist");
  return loaded;
}

test("ci mode reproduces the JavaScript CI gate in order", async () => {
  const { buildCommandPlan } = await loadModule();
  const root = path.resolve("/workspace/floatnote");

  assert.deepEqual(buildCommandPlan(["ci"], { platform: "linux", root }), [
    { command: "npm", args: ["ci"], cwd: root },
    { command: "npm", args: ["run", "version:check"], cwd: root },
    { command: "npm", args: ["run", "check"], cwd: root },
  ]);
});

test("release mode validates the tag and adds Rust checks", async () => {
  const { buildCommandPlan } = await loadModule();
  const root = path.resolve("/workspace/floatnote");
  const rustRoot = path.join(root, "src-tauri");

  assert.deepEqual(
    buildCommandPlan(["release", "--tag", "v0.2.0"], { platform: "linux", root }),
    [
      { command: "npm", args: ["ci"], cwd: root },
      { command: "npm", args: ["run", "version:check", "--", "--tag", "v0.2.0"], cwd: root },
      { command: "npm", args: ["run", "check"], cwd: root },
      { command: "cargo", args: ["test", "--lib"], cwd: rustRoot },
      { command: "cargo", args: ["check"], cwd: rustRoot },
      { command: "cargo", args: ["check", "--release"], cwd: rustRoot },
    ],
  );
});

test("Windows plans invoke npm.cmd", async () => {
  const { buildCommandPlan } = await loadModule();
  const plan = buildCommandPlan(["ci"], { platform: "win32", root: "C:\\FloatNote" });

  assert.equal(plan[0].command, "npm.cmd");
  assert.equal(plan[1].command, "npm.cmd");
  assert.equal(plan[2].command, "npm.cmd");
  assert.equal(plan[0].shell, true);
});

test("release mode requires one valid v-prefixed semantic version tag", async () => {
  const { buildCommandPlan } = await loadModule();

  assert.throws(() => buildCommandPlan(["release"]), /usage:/);
  assert.throws(() => buildCommandPlan(["release", "--tag", "0.2.0"]), /invalid release tag/);
  assert.throws(
    () => buildCommandPlan(["release", "--tag", "v0.2.0", "--tag", "v0.2.1"]),
    /usage:/,
  );
  assert.throws(() => buildCommandPlan(["unknown"]), /usage:/);
});

test("execution stops at the first failed command", async () => {
  const { runCommandPlan } = await loadModule();
  const calls = [];
  const plan = [
    { command: "npm", args: ["ci"], cwd: "/workspace" },
    { command: "npm", args: ["run", "check"], cwd: "/workspace" },
    { command: "cargo", args: ["check"], cwd: "/workspace/src-tauri" },
  ];
  const statuses = [0, 7];

  const status = runCommandPlan(plan, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: statuses.shift() };
  });

  assert.equal(status, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "inherit");
});

test("execution reports process spawn errors", async () => {
  const { runCommandPlan } = await loadModule();
  const failure = new Error("spawn failed");

  assert.throws(
    () => runCommandPlan(
      [{ command: "cargo", args: ["check"], cwd: "/workspace/src-tauri" }],
      () => ({ error: failure, status: null }),
    ),
    /could not run cargo check: spawn failed/,
  );
});
