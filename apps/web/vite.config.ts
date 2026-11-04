import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@husky/mavlink": r("../../packages/mavlink/src/index.ts"),
      "@husky/vehicle": r("../../packages/vehicle/src/index.ts"),
      "@husky/profile": r("../../packages/profile/src/index.ts"),
      "@husky/metadata": r("../../packages/metadata/src/index.ts"),
    },
  },
  server: { port: 5173, strictPort: true },
  // The parameter docs for each firmware are one lazily loaded chunk (~180 kB gzipped).
  build: { chunkSizeWarningLimit: 1600 },
});
