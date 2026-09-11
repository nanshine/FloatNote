import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./release-version.mjs", import.meta.url);

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(version = "0.1.0") {
  const root = await mkdtemp(path.join(os.tmpdir(), "floatnote-version-"));
  await writeJson(path.join(root, "package.json"), { name: "floatnote", version });
  await writeJson(path.join(root, "shared/note-logic/package.json"), { name: "logic", version });
  await writeJson(path.join(root, "package-lock.json"), {
    name: "floatnote",
    version,
    lockfileVersion: 3,
    packages: {
      "": { name: "floatnote", version },
      "shared/note-logic": { name: "logic", version },
    },
  });
  await writeJson(path.join(root, "src-tauri/tauri.conf.json"), { version: "../package.json" });
  await writeFile(path.join(root, "src-tauri/Cargo.toml"), `[package]\nname = "floatnote"\nversion = "${version}"\n`);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [script.pathname, ...args, "--root", root], {
    encoding: "utf8",
  });
}

test("check accepts a consistent version and matching release tag", async () => {
  const root = await fixture();
  const result = run(root, "check", "--tag", "v0.1.0");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0\.1\.0/);
});

test("check rejects a tag that differs from the canonical package version", async () => {
  const root = await fixture();
  const result = run(root, "check", "--tag", "v0.2.0");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag v0\.2\.0 does not match project version 0\.1\.0/);
});

test("check requires the release tag to include the v prefix", async () => {
  const root = await fixture();
  const result = run(root, "check", "--tag", "0.1.0");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag 0\.1\.0 does not match required tag v0\.1\.0/);
});

test("set updates every packaged version copy and the lockfile", async () => {
  const root = await fixture();
  const result = run(root, "set", "0.2.0-beta.1");

  assert.equal(result.status, 0, result.stderr);
  for (const relativePath of ["package.json", "shared/note-logic/package.json"]) {
    const pkg = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
    assert.equal(pkg.version, "0.2.0-beta.1");
  }
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.2.0-beta.1");
  assert.equal(lock.packages[""].version, "0.2.0-beta.1");
  assert.equal(lock.packages["shared/note-logic"].version, "0.2.0-beta.1");
  assert.match(await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8"), /version = "0\.2\.0-beta\.1"/);
  assert.equal(run(root, "check", "--tag", "v0.2.0-beta.1").status, 0);
});

test("set rejects invalid semantic versions without changing files", async () => {
  const root = await fixture();
  const result = run(root, "set", "release-1");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid semantic version/);
  assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, "0.1.0");
});

test("set validates every destination before changing any version", async () => {
  const root = await fixture();
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  delete lock.packages["shared/note-logic"];
  await writeJson(lockPath, lock);

  const result = run(root, "set", "0.2.0");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing workspace entry: shared\/note-logic/);
  for (const relativePath of ["package.json", "shared/note-logic/package.json"]) {
    const pkg = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
    assert.equal(pkg.version, "0.1.0");
  }
  assert.match(await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8"), /version = "0\.1\.0"/);
});

test("set validates the Tauri version source before changing any version", async () => {
  const root = await fixture();
  await writeJson(path.join(root, "src-tauri/tauri.conf.json"), { version: "0.1.0" });

  const result = run(root, "set", "0.2.0");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must read its version from \.\.\/package\.json/);
  assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, "0.1.0");
  assert.match(await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8"), /version = "0\.1\.0"/);
});
