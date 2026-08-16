/// <reference types="vitest" />
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The native ResoStage app looks for this dev server first (see the Electron
// shell's DEV_URL) and falls back to the last `pnpm build` output served by
// the embedded backend (the packaged Contents/Resources/web folder, or
// ui/dist in dev) if it can't be reached -- port must stay in sync with that
// fallback probe.
const DEV_PORT = 2900

/**
 * Full reload for the files HMR cannot meaningfully patch.
 *
 * Deliberately not a blanket "always reload": ordinary component edits keep
 * their fast refresh, which is the whole reason to run a dev server at all.
 * But the theme layer and the rAF driver both hold module-level caches that
 * survive a hot swap, so patching them leaves a page that is half on the old
 * state -- harder to debug than the reload it saved.
 */
const fullReloadOn = (): PluginOption => ({
  name: 'resostage-full-reload',
  handleHotUpdate({ file, server }) {
    const hard =
      file.endsWith('vite.config.ts') ||
      file.endsWith('/src/styles/theme.css') ||
      file.endsWith('/src/styles/themes.css') ||
      file.endsWith('/src/lib/theme.ts') ||
      file.endsWith('/src/lib/rafLoop.ts')
    if (!hard) return
    server.ws.send({ type: 'full-reload', path: '*' })
    return []
  },
})

export default defineConfig({
  // Normal multi-file build (index.html + assets/*.js + assets/*.css, plus
  // whatever images/fonts/etc. get added later) -- buildApp copies the whole
  // dist/ tree into the app bundle's Contents/Resources/web, and
  // WebServer::serveStatic() serves each file by its real path with the right
  // MIME type. (An earlier version baked every asset into a generated C++
  // header via scripts/embed.mjs; that's been replaced by the folder copy.)
  plugins: [react(), tailwindcss(), fullReloadOn()],
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:2899',
        changeOrigin: true,
      },
    },
    // Compile the entry graph while the server starts rather than when the
    // browser first asks for it. Without this the first paint pays for a
    // request waterfall hundreds of modules deep -- each import discovered
    // only once its parent has finished being transformed.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/screens/PlayerScreen.tsx',
        './src/screens/EditorScreen.tsx',
        './src/components/timeline/Timeline.tsx',
      ],
    },
    watch: {
      // Chokidar indexes everything under the root by default, including
      // build output and the C++ tree next door. On a project this size that
      // is thousands of descriptors held open plus a steady idle CPU cost,
      // for directories no dev-server reload could ever care about.
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/.vite/**',
        '**/*.log',
        // The JUCE side of the repo: a C++ rebuild writing object files must
        // not wake the front end.
        '**/core/**',
        '**/electron/dist/**',
        '**/electron/native/**',
      ],
      // Polling burns a core doing nothing. Only ever needed over network
      // shares and some container mounts, neither of which applies here.
      usePolling: false,
    },
  },
  optimizeDeps: {
    // Pre-bundled up front so none of these can trigger a mid-session
    // re-optimize, which stalls the server and force-reloads the page. The
    // three.js family matters most: it is thousands of small ESM files, and
    // discovering it late is why opening the Light tab used to pause.
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'use-sync-external-store',
      'use-sync-external-store/shim/with-selector',
      'use-sync-external-store/with-selector',
      'framer-motion',
      '@heroui/react',
      'react-aria-components',
      'three',
      '@react-three/fiber',
      '@react-three/drei',
      'lucide-react',
    ],
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/use-sync-external-store') ||
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/framer-motion') ||
            id.includes('node_modules/@heroui')
          ) {
            return 'vendor-core'
          }
        },
      },
    },
  },
  test: {
    pool: 'threads',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
