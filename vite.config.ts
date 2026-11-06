import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  // MapLibre v6 starts its tile worker from import.meta.url; Vite pre-bundling breaks that path.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  build: { outDir: "dist/client" },
  server: { proxy: { "/api": "http://localhost:8080" } },
});
