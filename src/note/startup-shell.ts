/** Keep the HTML recovery surface alive until the application is usable. */
export async function runStartup(
  start: () => Promise<void>,
  reveal: () => Promise<void> = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("reveal_startup_window");
  },
): Promise<void> {
  const shell = document.querySelector<HTMLElement>("#startup-shell")!;
  const message = document.querySelector<HTMLElement>("#startup-message")!;
  const app = document.querySelector<HTMLElement>("#app")!;
  const timeout = window.setTimeout(() => {
    shell.dataset.state = "slow";
    message.textContent = "还需要一点时间…";
  }, 15_000);
  try {
    await start();
    app.removeAttribute("inert");
    shell.remove();
  } catch (reason) {
    console.error("Startup failed", reason);
    shell.dataset.state = "failed";
    message.textContent = "暂时无法打开笔记";
  } finally {
    window.clearTimeout(timeout);
    // Do not wait for the slow-start threshold after success or failure.
    await reveal().catch((reason) => console.error("Window reveal failed", reason));
  }
}
