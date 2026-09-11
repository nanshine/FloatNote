import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createManifest, validateKey, compareVersions, selectChannelUpdates } from "./update-release.mjs";

// Exercise the real Tauri signer format without retaining any test private key.
test("manifest accepts actual Tauri signatures and rejects incomplete or mismatched releases", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "floatnote-update-test-"));
  const cli = path.resolve("node_modules/@tauri-apps/cli/tauri.js");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, "signer", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, "Tauri signer failed");
  };
  try {
    const keyPath = path.join(dir, "test.key");
    const artifact = path.join(dir, "artifact");
    run("generate", "--ci", "-p", "", "-w", keyPath);
    await writeFile(artifact, "test update package");
    run("sign", "-f", keyPath, "-p", "", artifact);
    const key = await readFile(`${keyPath}.pub`, "utf8");
    const signature = await readFile(`${artifact}.sig`, "utf8");
    assert.equal(validateKey(key).length, 8);
    const names = ["aarch64.app.tar.gz", "x86_64.app.tar.gz", "x86_64-setup.exe"].map((suffix) => `FloatNote_0.2.0_${suffix}`);
    const release = { tag_name: "v0.2.0", draft: false, published_at: "2026-09-10T00:00:00Z", body: "Release notes", assets: names.map((name) => ({ name, size: 123, browser_download_url: `https://example.com/${name}` })) };
    const signatures = Object.fromEntries(names.map((name) => [`${name}.sig`, signature]));
    assert.equal(Object.keys(createManifest(release, signatures, key).platforms).length, 3);
    assert.throws(() => createManifest({ ...release, draft: true }, signatures, key), /published/);
    assert.throws(() => createManifest({ ...release, assets: release.assets.slice(1) }, signatures, key), /Missing/);
    assert.throws(() => createManifest(release, {}, key), /Missing/);
    const secondKey = path.join(dir, "other.key");
    run("generate", "--ci", "-p", "", "-w", secondKey);
    const otherKey = await readFile(`${secondKey}.pub`, "utf8");
    assert.throws(() => createManifest(release, signatures, otherKey), /does not match/);
    assert.throws(() => validateKey(""), /PUBLIC_KEY/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("channel ordering prevents downgrades and compares prerelease numbers semantically", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-beta.10") > 0);
  assert.ok(compareVersions("0.9.0", "1.0.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("stable releases advance stable and migrate older preview clients", () => {
  const manifest = { version: "0.2.1" };
  assert.deepEqual(selectChannelUpdates(
    { prerelease: false },
    manifest,
    { preview: { version: "0.2.0" } },
  ), ["stable", "preview"]);
  assert.deepEqual(selectChannelUpdates(
    { prerelease: false },
    manifest,
    { preview: { version: "0.3.0-beta.1" } },
  ), ["stable"]);
});

test("every required channel remains monotonic", () => {
  assert.throws(() => selectChannelUpdates(
    { prerelease: true },
    { version: "0.2.1" },
    { preview: { version: "0.2.1" } },
  ), /equal or newer/);
  assert.throws(() => selectChannelUpdates(
    { prerelease: false },
    { version: "0.2.1" },
    { stable: { version: "0.2.2" } },
  ), /equal or newer/);
});
