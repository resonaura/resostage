import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The native ResoStage app looks for this dev server first (see
// DevOrEmbeddedWebView) and falls back to the last `pnpm build` output
// (embedded into the C++ binary, see scripts/embed.mjs) if it can't be
// reached -- port must stay in sync with that fallback probe.
const DEV_PORT = 2900

export default defineConfig({
  // Normal multi-file build (index.html + assets/*.js + assets/*.css, plus
  // whatever images/fonts/etc. get added later) -- scripts/embed.mjs walks
  // the whole dist/ tree and embeds every file as its own named asset, and
  // WebServer::serveStatic() serves each by its real path with the right
  // MIME type. (An earlier version force-inlined everything into one
  // index.html via vite-plugin-singlefile; dropped that so adding new
  // assets -- images, fonts, whatever -- doesn't require it either.)
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
