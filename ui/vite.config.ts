import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The native ResoStage app looks for this dev server first (see the Electron
// shell's DEV_URL) and falls back to the last `pnpm build` output served by
// the embedded backend (the packaged Contents/Resources/web folder, or
// ui/dist in dev) if it can't be reached -- port must stay in sync with that
// fallback probe.
const DEV_PORT = 2900

export default defineConfig({
  // Normal multi-file build (index.html + assets/*.js + assets/*.css, plus
  // whatever images/fonts/etc. get added later) -- buildApp copies the whole
  // dist/ tree into the app bundle's Contents/Resources/web, and
  // WebServer::serveStatic() serves each file by its real path with the right
  // MIME type. (An earlier version baked every asset into a generated C++
  // header via scripts/embed.mjs; that's been replaced by the folder copy.)
  plugins: [react(), tailwindcss()],
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:2899',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
