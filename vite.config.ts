import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    // Cargo owns these files; watching locked Windows binaries can stop Vite.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        popup: resolve(__dirname, "popup.html"),
        history: resolve(__dirname, "history.html"),
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts", "shared/**/*.test.ts"] },
});
