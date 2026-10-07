import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // En dev, l'app (5173) parle au serveur local Relay (5174).
    proxy: { "/api": "http://127.0.0.1:5174" },
  },
  build: { outDir: "dist" },
});
