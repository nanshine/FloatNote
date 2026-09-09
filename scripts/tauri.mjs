import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);

export function buildTauriEnvironment(options = {}) {
  const platform = options.platform ?? process.platform;
  const rootDir = path.resolve(options.rootDir ?? projectRoot);
  const environment = { ...(options.environment ?? process.env) };

  if (platform === "darwin") {
    const toolsDirectory = path.join(rootDir, "scripts", "macos-dmg-tools");
    environment.PATH = environment.PATH
      ? `${toolsDirectory}${path.delimiter}${environment.PATH}`
      : toolsDirectory;
  }

  return environment;
}

export function runTauri(args, options = {}) {
  const effectiveArgs = args[0] === "dev"
    ? [...args, "--config", "src-tauri/tauri.dev.conf.json"]
    : args;
  const result = (options.spawn ?? spawnSync)(
    process.execPath,
    [tauriCli, ...effectiveArgs],
    {
      cwd: options.cwd ?? process.cwd(),
      env: buildTauriEnvironment(options),
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw new Error(`could not run Tauri CLI: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function main() {
  process.exitCode = runTauri(process.argv.slice(2));
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
