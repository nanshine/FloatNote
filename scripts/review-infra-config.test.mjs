import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

test("review scripts use browser mode and the dev-process doctor", async () => {
  const pkg = await json("package.json");
  assert.equal(pkg.scripts["review:ui"], "node ./scripts/review-ui.mjs");
  assert.equal(pkg.scripts["review:native:doctor"], "node ./scripts/native-review-doctor.mjs");
  assert.equal(pkg.scripts["test:infra"], "node --test ./scripts/*.test.mjs");
  assert.equal(pkg.scripts["review:build"], undefined);
  assert.equal(pkg.scripts["review:app"], undefined);
});

test("browser review bypasses proxies for loopback WebDriver traffic", async () => {
  const config = await readFile(new URL("wdio.browser.conf.ts", root), "utf8");
  assert.match(config, /\["NO_PROXY", "no_proxy"\]/);
  assert.match(config, /entries\.add\("127\.0\.0\.1"\)/);
  assert.match(config, /entries\.add\("localhost"\)/);
});

test("WDIO Rust plugins are optional and gated by the e2e-wdio feature", async () => {
  const cargo = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
  const lib = await readFile(new URL("src-tauri/src/lib.rs", root), "utf8");
  assert.match(cargo, /e2e-wdio\s*=\s*\["dep:tauri-plugin-wdio",\s*"dep:tauri-plugin-wdio-webdriver"\]/);
  assert.match(cargo, /tauri-plugin-wdio\s*=\s*\{\s*version\s*=\s*"1",\s*optional\s*=\s*true\s*\}/);
  assert.match(cargo, /tauri-plugin-wdio-webdriver\s*=\s*\{\s*version\s*=\s*"1",\s*optional\s*=\s*true\s*\}/);
  assert.match(lib, /#\[cfg\(all\(debug_assertions, feature = "e2e-wdio"\)\)\]/);
});

test("review-only capability is excluded from the normal application config", async () => {
  const baseConfig = await json("src-tauri/tauri.conf.json");
  const reviewConfig = await json("src-tauri/tauri.review.conf.json");
  const defaultCapability = await json("src-tauri/capabilities/default.json");
  const reviewCapability = reviewConfig.app.security.capabilities[1];

  assert.deepEqual(baseConfig.app.security.capabilities, ["default"]);
  assert.equal(reviewConfig.app.security.capabilities[0], "default");
  assert.equal(defaultCapability.permissions.includes("wdio:default"), false);
  assert.deepEqual(reviewCapability.permissions, ["wdio:default"]);
  assert.deepEqual(reviewCapability.windows, ["main"]);
});

test("bundled skills map directly beneath Tauri's resource directory", async () => {
  const config = await json("src-tauri/tauri.conf.json");
  const service = await readFile(new URL("src-tauri/src/agent/service.rs", root), "utf8");

  assert.deepEqual(config.bundle.resources, {
    "resources/skills/": "skills/",
  });
  assert.match(service, /resource_dir\(\)[\s\S]*?\.join\("skills"\)/);
});

test("release packaging contains the pinned Rust agent and no Node sidecar", async () => {
  const config = await json("src-tauri/tauri.conf.json");
  const pkg = await json("package.json");
  const cargo = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
  assert.equal(config.bundle.externalBin, undefined);
  assert.equal(config.bundle.macOS.entitlements, undefined);
  assert.deepEqual(pkg.workspaces, ["shared/note-logic"]);
  assert.equal(pkg.scripts["package:sidecar"], undefined);
  assert.match(cargo, /rig-core = \{ version = "=0\.42\.0"/);
  assert.match(cargo, /rig-agent = \{ version = "=0\.42\.0"/);
  assert.doesNotMatch(cargo, /tauri-plugin-shell/);
  await assert.rejects(readFile(new URL("src-tauri/Entitlements.plist", root), "utf8"));
});

test("preview releases use the root package version, DMG bundles, and ad-hoc signing", async () => {
  const pkg = await json("package.json");
  const config = await json("src-tauri/tauri.conf.json");

  assert.equal(pkg.scripts["version:check"], "node ./scripts/release-version.mjs check");
  assert.equal(pkg.scripts["version:set"], "node ./scripts/release-version.mjs set");
  assert.equal(config.version, "../package.json");
  assert.equal(config.bundle.targets, "dmg");
  assert.equal(config.bundle.macOS.signingIdentity, "-");
});

test("GitHub Actions validate changes and publish both native macOS architectures", async () => {
  const pkg = await json("package.json");
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const release = await readFile(new URL(".github/workflows/release.yml", root), "utf8");
  const rustJob = ci.match(/(?:^|\n)  rust:\n[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:\n|$)/)?.[0];

  assert.equal(pkg.scripts["ci:local"], "node ./scripts/local-ci.mjs ci");
  assert.equal(pkg.scripts["release:check"], "node ./scripts/local-ci.mjs release");
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm run check/);
  assert.ok(rustJob, "CI must define a rust job");
  assert.match(
    rustJob,
    /actions\/setup-node@v4[\s\S]*?npm ci[\s\S]*?cargo test --lib/,
  );
  assert.match(ci, /cargo test --lib/);
  assert.match(ci, /cargo check --release/);

  assert.match(release, /tags:[\s\S]*?- "v\*"/);
  assert.match(release, /macos-15-intel/);
  assert.match(release, /macos-15/);
  assert.match(release, /aarch64-apple-darwin/);
  assert.match(release, /x86_64-apple-darwin/);
  assert.match(release, /tauri-apps\/tauri-action@v1/);
  assert.match(
    release,
    /args: --target \$\{\{ matrix\.target \}\} --bundles app,dmg/,
    "release builds must retain the app bundle instead of treating it as a temporary DMG input",
  );
  assert.match(release, /-F draft=true/);
  assert.match(release, /-F prerelease=true/);
  assert.match(release, /generate_release_notes=true/);
  assert.match(release, /if \[ "\$is_prerelease" != "true" \]; then/);
  assert.doesNotMatch(release, /\$is_draft" != "true"/);
  assert.match(release, /Published releases are immutable/);
  assert.match(release, /FloatNote_\$\{app_version\}_\$\{\{ matrix\.arch \}\}\.dmg/);
  assert.match(release, /FloatNote_\$\{\{ matrix\.arch \}\}\.dmg/);
  assert.match(release, /FloatNote_\$\{app_version\}_\$\{\{ matrix\.arch \}\}\.app\.tar\.gz/);
  assert.match(release, /FloatNote_x86_64-setup\.exe/);
  assert.match(release, /prepare_release:/);
  assert.match(release, /gh api --method POST/);
  assert.match(release, /gh api --paginate/);
  assert.doesNotMatch(release, /releases\/tags\/\$RELEASE_TAG/);
  assert.match(release, /needs: prepare_release/);
  assert.match(release, /RELEASE_ID: \$\{\{ needs\.prepare_release\.outputs\.release_id \}\}/);
});

test("README platform links download fixed-name assets from the latest release", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");

  for (const asset of [
    "FloatNote_aarch64.dmg",
    "FloatNote_x86_64.dmg",
    "FloatNote_x86_64-setup.exe",
  ]) {
    assert.match(
      readme,
      new RegExp(`https://github\\.com/nanshine/FloatNote/releases/latest/download/${asset.replaceAll(".", "\\.")}`),
    );
  }
});

test("macOS releases import Developer ID credentials, notarize, and verify artifacts", async () => {
  const release = await readFile(new URL(".github/workflows/release.yml", root), "utf8");

  assert.match(release, /APPLE_CERTIFICATE: \$\{\{ secrets\.APPLE_CERTIFICATE \}\}/);
  assert.match(release, /APPLE_CERTIFICATE_PASSWORD: \$\{\{ secrets\.APPLE_CERTIFICATE_PASSWORD \}\}/);
  assert.match(release, /security create-keychain/);
  assert.match(release, /security import/);
  assert.match(release, /Developer ID Application:/);
  assert.match(release, /APPLE_TEAM_ID: \$\{\{ secrets\.APPLE_TEAM_ID \}\}/);
  assert.match(release, /APPLE_SIGNING_IDENTITY=.*GITHUB_ENV/);

  assert.match(release, /APPLE_API_PRIVATE_KEY: \$\{\{ secrets\.APPLE_API_PRIVATE_KEY \}\}/);
  assert.match(release, /AuthKey_\$\{APPLE_API_KEY_ID\}\.p8/);
  assert.match(release, /APPLE_API_KEY_PATH=.*GITHUB_ENV/);
  assert.match(release, /APPLE_API_ISSUER: \$\{\{ secrets\.APPLE_API_ISSUER \}\}/);
  assert.match(release, /APPLE_API_KEY: \$\{\{ secrets\.APPLE_API_KEY_ID \}\}/);
  assert.match(release, /APPLE_API_KEY_PATH: \$\{\{ env\.APPLE_API_KEY_PATH \}\}/);
  assert.match(release, /APPLE_SIGNING_IDENTITY: \$\{\{ env\.APPLE_SIGNING_IDENTITY \}\}/);
  assert.match(release, /find "\$bundle_directory" -maxdepth 3 -print/);

  assert.match(release, /xcrun notarytool submit "\$dmg_path"/);
  assert.match(release, /--key "\$APPLE_API_KEY_PATH"/);
  assert.match(release, /--key-id "\$APPLE_API_KEY_ID"/);
  assert.match(release, /--issuer "\$APPLE_API_ISSUER"/);
  assert.match(release, /--wait/);
  assert.match(release, /xcrun stapler staple "\$dmg_path"/);
  assert.match(release, /codesign --verify --deep --strict/);
  assert.match(release, /xcrun stapler validate/);
  assert.match(release, /spctl --assess --type execute/);
  assert.match(release, /spctl --assess[\s\\]*--type open/);
  assert.match(release, /--jq '\.upload_url'/);
  assert.match(release, /curl --silent --show-error --location/);
  assert.match(release, /--data-binary "@\$asset_path"/);
  assert.match(release, /encodeURIComponent\(process\.argv\[1\]\)/);
  assert.match(release, /\?name=\$encoded_asset_name/);

  const notarizeDmg = release.indexOf('xcrun notarytool submit "$dmg_path"');
  const stapleDmg = release.indexOf('xcrun stapler staple "$dmg_path"');
  const validateDmg = release.indexOf('xcrun stapler validate "$dmg_path"');
  const uploadAssets = release.indexOf("Upload verified release assets");
  assert.ok(notarizeDmg < stapleDmg, "DMG notarization must happen before stapling");
  assert.ok(stapleDmg < validateDmg, "DMG stapling must happen before validation");
  assert.ok(validateDmg < uploadAssets, "DMG validation must happen before upload");
  assert.doesNotMatch(release, /secrets\.APPLE_ID/);
  assert.doesNotMatch(release, /secrets\.APPLE_PASSWORD/);
});
