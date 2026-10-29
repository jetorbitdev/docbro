import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and must not clear the terminal
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // The editor and the .docx converters make one ~1.1 MB chunk; it loads from disk, so size costs nothing
  build: { chunkSizeWarningLimit: 2000 },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
