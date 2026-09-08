import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  devToolbar: { enabled: false },
  server: {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 4321),
  },
  vite: {
    server: {
      proxy: {
        "/api": { target: "http://127.0.0.1:3333", changeOrigin: false },
        "/health": { target: "http://127.0.0.1:3333", changeOrigin: false },
      },
    },
  },
});
