import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { copyFileSync } from "node:fs";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-extension-manifest",
      closeBundle() {
        copyFileSync(resolve(process.cwd(), "manifest.json"), resolve(process.cwd(), "dist/manifest.json"));
      }
    }
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(process.cwd(), "popup.html"),
        background: resolve(process.cwd(), "src/background.ts"),
        content: resolve(process.cwd(), "src/content/index.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
