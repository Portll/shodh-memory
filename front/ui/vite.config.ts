import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

// The shodh-front Rust binary embeds the built UI with include_str!, so the
// build MUST produce exactly one self-contained file at dist/index.html —
// no sibling .js/.css, no hashed asset names to chase. viteSingleFile inlines
// every chunk and stylesheet into the HTML. Code splitting buys nothing here
// (one screen, loaded from localhost) and would break the embed.
//
// Dev mirrors what the Rust front does in production: proxy /api/* to the
// backend. Without this, fetches 404 in `vite dev` and work in the binary,
// which is the worst possible way for a bug to present.
const BACKEND = process.env.SHODH_API_URL ?? "http://127.0.0.1:3030";
const API_KEY = process.env.SHODH_API_KEY ?? "";
const SEAT = process.env.SHODH_SEAT_URL ?? "http://127.0.0.1:3141";
const SEAT_TOKEN = process.env.SHODH_SEAT_TOKEN ?? "";

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 8788,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
        // The dev proxy injects the same header the Rust front injects in
        // production, so the browser never holds the key in either mode.
        headers: API_KEY ? { "X-API-Key": API_KEY } : undefined,
      },
      // Same contract as the Rust front's /seat/* route: strip the prefix,
      // inject the seat bearer token, stream (SSE) without buffering.
      "/seat": {
        target: SEAT,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/seat/, ""),
        headers: SEAT_TOKEN ? { Authorization: `Bearer ${SEAT_TOKEN}` } : undefined,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Inlining requires a single chunk; assetsInlineLimit lifts the cutoff so
    // nothing is emitted as a separate file the Rust binary would not embed.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});
