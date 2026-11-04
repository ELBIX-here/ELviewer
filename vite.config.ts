import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import type { Plugin } from "vite";
const host = process.env.TAURI_DEV_HOST;

/**
 * foliate-js fixed-layout.js reads `this.side` (undefined) instead of the private `#side`,
 * so in portrait – where a two-page spread is shown one page at a time – it reports the
 * right page while the left one is on screen. Comics then jump to 100% one page early.
 */
const foliateFxlSideFix = (): Plugin => ({
  name: "foliate-fxl-side-fix",
  enforce: "pre",
  transform(code, id) {
    if (!/foliate-js[\\/]fixed-layout\.js$/.test(id.split("?")[0])) return;
    return code.replace("spread?.center ?? (this.side === 'left'", "spread?.center ?? (this.#side === 'left'");
  },
});

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), foliateFxlSideFix()],
  // Keep foliate-js out of dependency pre-bundling so the transform above also applies in dev.
  optimizeDeps: { exclude: ["foliate-js"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
