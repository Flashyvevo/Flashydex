import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` → self-signed TLS so a phone on the LAN gets a secure context
// (Web Locks, PWA install, camera). Accept the certificate once in Safari/Chrome.
const useHttps = process.env.FLASHYDEX_DEV_HTTPS === '1';
import { excludeDevPacks } from './scripts/exclude-dev-packs';

export default defineConfig({
  plugins: [
    ...(useHttps ? [basicSsl({ name: 'flashydex-dev', domains: ['localhost'] })] : []),
    TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    excludeDevPacks(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'FlashyDex',
        short_name: 'FlashyDex',
        description: 'A local-first trading card collection manager.',
        theme_color: '#101114',
        background_color: '#101114',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//], globIgnores: ['**/dev-packs/**'] }
    })
  ],
  envPrefix: ['VITE_', 'FLASHYDEX_'],
  // jeep-sqlite is a lazy-loading Stencil bundle; pre-bundling breaks its chunk resolution.
  optimizeDeps: { exclude: ['jeep-sqlite'] },
  worker: { format: 'es' },
  resolve: {
    alias: { '@': resolve(__dirname, './src') }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts'
  }
});
