import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 3010,
    /** Must stay on 3010 — API uses 3011; falling back to 3011 breaks the /api proxy. */
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3011",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: true,
    port: 3010,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3011",
        changeOrigin: true,
      },
    },
  },
});
