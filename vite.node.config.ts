import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "src/node/index.ts",
    target: "node24",
    outDir: "dist/node",
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: "server.js" } },
  },
});
