import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildTauriEnvironment, runTauri } from "./tauri.mjs";

const root = new URL("../", import.meta.url);

test("macOS Tauri runs with the DMG SetFile shim first on PATH", () => {
  const environment = buildTauriEnvironment({
    platform: "darwin",
    rootDir: "/workspace/FloatNote",
    environment: { PATH: "/usr/bin:/bin", KEEP_ME: "yes" },
  });

  assert.equal(
    environment.PATH,
    "/workspace/FloatNote/scripts/macos-dmg-tools:/usr/bin:/bin",
  );
  assert.equal(environment.KEEP_ME, "yes");
});

test("non-macOS Tauri keeps the original PATH", () => {
  const environment = buildTauriEnvironment({
    platform: "win32",
    rootDir: "C:\\FloatNote",
    environment: { PATH: "C:\\Windows" },
  });

  assert.equal(environment.PATH, "C:\\Windows");
});

test("dev runs append the isolated development identity after caller configs", () => {
  let spawned;
  const status = runTauri(["dev", "--config", "src-tauri/tauri.review.conf.json"], {
    spawn: (_command, args) => { spawned = args; return { status: 0 }; },
  });
  assert.equal(status, 0);
  assert.deepEqual(spawned.slice(-4), ["--config", "src-tauri/tauri.review.conf.json", "--config", "src-tauri/tauri.dev.conf.json"]);
});

test("build runs keep the production identity", () => {
  let spawned;
  runTauri(["build"], { spawn: (_command, args) => { spawned = args; return { status: 0 }; } });
  assert.ok(!spawned.includes("src-tauri/tauri.dev.conf.json"));
});

test("the DMG SetFile shim removes Tauri's custom volume icon", {
  skip: process.platform !== "darwin",
}, async () => {
  const shim = fileURLToPath(
    new URL("macos-dmg-tools/SetFile", import.meta.url),
  );
  await access(shim, constants.X_OK);

  const mount = await mkdtemp(path.join(tmpdir(), "floatnote-dmg-volume-"));
  const volumeIcon = path.join(mount, ".VolumeIcon.icns");
  try {
    await writeFile(volumeIcon, "custom icon");

    const result = spawnSync(
      shim,
      ["-a", "C", mount],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(volumeIcon), { code: "ENOENT" });
  } finally {
    await rm(mount, { recursive: true, force: true });
  }
});

test("the DMG SetFile shim only intercepts custom volume icon operations", {
  skip: process.platform !== "darwin",
}, async () => {
  const shim = fileURLToPath(
    new URL("macos-dmg-tools/SetFile", import.meta.url),
  );
  const mount = await mkdtemp(path.join(tmpdir(), "floatnote-setfile-scope-"));
  const volumeIcon = path.join(mount, ".VolumeIcon.icns");
  const unrelatedFile = path.join(mount, "unrelated.txt");

  try {
    await writeFile(volumeIcon, "custom icon");
    await writeFile(unrelatedFile, "content");

    const iconTypeResult = spawnSync(
      shim,
      ["-c", "icnC", volumeIcon],
      { encoding: "utf8" },
    );
    assert.equal(iconTypeResult.status, 0, iconTypeResult.stderr);
    await access(volumeIcon);

    const passthroughResult = spawnSync(
      shim,
      ["-a", "V", unrelatedFile],
      { encoding: "utf8" },
    );
    assert.equal(passthroughResult.status, 0, passthroughResult.stderr);

    const attributes = spawnSync(
      "/usr/bin/GetFileInfo",
      ["-a", unrelatedFile],
      { encoding: "utf8" },
    );
    assert.equal(attributes.status, 0, attributes.stderr);
    assert.match(attributes.stdout, /V/);
  } finally {
    await rm(mount, { recursive: true, force: true });
  }
});

test("local and release builds use the Tauri wrapper", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const release = await readFile(
    new URL(".github/workflows/release.yml", root),
    "utf8",
  );

  assert.equal(pkg.scripts.tauri, "node ./scripts/tauri.mjs");
  assert.match(release, /tauriScript: npm run tauri/);
});
