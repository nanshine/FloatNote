import { invoke } from "@tauri-apps/api/core";

/** Opens a URL through the native handler after backend validation. */
export function openUrl(url: string): Promise<unknown> {
  return Promise.resolve(invoke("open_url", { url }));
}

/** Opens a rendered link through the Rust allowlist instead of navigating the
 * current webview. The backend accepts only http, https, and mailto URLs. */
export function wireOpenUrlLink(anchor: HTMLAnchorElement, url: string): void {
  anchor.href = url;
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openUrl(url).catch(() => undefined);
  });
}
