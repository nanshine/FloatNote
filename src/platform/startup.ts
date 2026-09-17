/** WebView2 can invoke commands before Tauri setup has registered AppState. */
export async function withAppState<T>(request: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await request();
    } catch (reason) {
      if (!String(reason).includes("state not managed") || Date.now() >= deadline) throw reason;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
