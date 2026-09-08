import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const usage = "usage: local-ci.mjs ci | release --tag vX.Y.Z";

function npmCommand(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function npmStep(command, args, root) {
  const step = { command, args, cwd: root };
  if (command.endsWith(".cmd")) step.shell = true;
  return step;
}

function ciSteps(command, root, tag) {
  const versionArgs = ["run", "version:check"];
  if (tag) versionArgs.push("--", "--tag", tag);

  return [
    npmStep(command, ["ci"], root),
    npmStep(command, versionArgs, root),
    npmStep(command, ["run", "check"], root),
  ];
}

function parseReleaseTag(args) {
  if (args.length !== 2 || args[0] !== "--tag") throw new Error(usage);
  const tag = args[1];
  if (!tag?.startsWith("v") || !semverPattern.test(tag.slice(1))) {
    throw new Error(`invalid release tag: ${tag ?? "(missing)"}`);
  }
  return tag;
}

export function buildCommandPlan(argv, options = {}) {
  const platform = options.platform ?? process.platform;
  const root = path.resolve(options.root ?? process.cwd());
  const command = npmCommand(platform);
  const [mode, ...args] = argv;

  if (mode === "ci" && args.length === 0) return ciSteps(command, root);
  if (mode !== "release") throw new Error(usage);

  const tag = parseReleaseTag(args);
  const rustRoot = path.join(root, "src-tauri");
  return [
    ...ciSteps(command, root, tag),
    { command: "cargo", args: ["test", "--lib"], cwd: rustRoot },
    { command: "cargo", args: ["check"], cwd: rustRoot },
    { command: "cargo", args: ["check", "--release"], cwd: rustRoot },
  ];
}

export function runCommandPlan(plan, spawn = spawnSync) {
  for (const step of plan) {
    const result = spawn(step.command, step.args, {
      cwd: step.cwd,
      shell: step.shell ?? false,
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error(`could not run ${step.command} ${step.args.join(" ")}: ${result.error.message}`);
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function main() {
  const plan = buildCommandPlan(process.argv.slice(2));
  process.exitCode = runCommandPlan(plan);
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
