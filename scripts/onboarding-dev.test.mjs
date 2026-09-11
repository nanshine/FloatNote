import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { onboardingProfilePath, validateResetTarget } from "./onboarding-dev.mjs";

test("onboarding reset accepts only the exact sandbox profile", async () => {
  const root = path.resolve("/tmp/floatnote-reset-test");
  assert.equal(await validateResetTarget(onboardingProfilePath(root), root), onboardingProfilePath(root));
  await assert.rejects(validateResetTarget(path.join(root, "src-tauri", "target", "dev-profiles", "default"), root));
  await assert.rejects(validateResetTarget(path.join(root, "src-tauri", "target", "dev-profiles"), root));
  await assert.rejects(validateResetTarget("src-tauri/target/dev-profiles/onboarding", root));
});

test("onboarding reset rejects a symbolic-link path component", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "floatnote-reset-link-"));
  const outside = await mkdtemp(path.join(tmpdir(), "floatnote-reset-outside-"));
  try {
    await mkdir(path.join(root, "src-tauri", "target"), { recursive: true });
    await symlink(outside, path.join(root, "src-tauri", "target", "dev-profiles"));
    await assert.rejects(validateResetTarget(onboardingProfilePath(root), root), /symbolic/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
