import { defineConfig } from "vite";

// Tauri expects a fixed dev port; build output goes to ../dist so the Rust
// bundle can pick it up via frontendDist in tauri.conf.json.
export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
