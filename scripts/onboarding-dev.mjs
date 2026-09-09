import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runTauri } from "./tauri.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function onboardingProfilePath(root = projectRoot) {
  return path.resolve(root, "src-tauri", "target", "dev-profiles", "onboarding");
}

export async function validateResetTarget(target, root = projectRoot) {
  const expected = onboardingProfilePath(root);
  if (!path.isAbsolute(target) || path.normalize(target) !== expected) {
    throw new Error(`refusing to reset unexpected path: ${target}`);
  }
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("reset target escapes repository");
  const absoluteRoot = path.resolve(root);
  let cursor = absoluteRoot;
  for (const segment of path.relative(absoluteRoot, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`refusing symbolic path component: ${cursor}`);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("refusing to reset a symbolic link");
    if (await realpath(target) !== target) throw new Error("reset target contains symbolic links");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return expected;
}

export async function resetOnboardingProfile(root = projectRoot) {
  const target = await validateResetTarget(onboardingProfilePath(root), root);
  await rm(target, { recursive: true, force: true });
}

async function main() {
  const action = process.argv[2] ?? "dev";
  if (action === "reset" || action === "fresh") await resetOnboardingProfile();
  if (action === "reset") return;
  if (action !== "dev" && action !== "fresh") throw new Error(`unknown action: ${action}`);
  process.exitCode = runTauri(["dev"], {
    cwd: projectRoot,
    environment: { ...process.env, FLOATNOTE_DEV_PROFILE: "onboarding" },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
