import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// HOST env var exposes the dev server on the network (default: localhost).
// Set HOST=0.0.0.0 to listen on all interfaces.
const HOST = process.env.HOST || "localhost";
const BACKEND_PORT = process.env.BACKEND_PORT || "5174";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: HOST,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://${HOST === "localhost" ? "localhost" : "127.0.0.1"}:${BACKEND_PORT}`,
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist", "web"),
    emptyOutDir: true,
  },
});
