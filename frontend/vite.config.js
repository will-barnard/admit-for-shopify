import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

/**
 * Inject the Shopify App Bridge script.
 *
 * App Bridge must be the FIRST script tag on the page. It is injected here
 * rather than hardcoded in index.html so that it is omitted entirely when no
 * client id is configured - a literal unsubstituted placeholder would make
 * App Bridge initialise against a nonsense key and break the standalone app.
 *
 * The key is the app's client_id: a public identifier, visible in page source
 * either way, not a secret.
 */
function shopifyAppBridge() {
  return {
    name: 'shopify-app-bridge',
    transformIndexHtml(html) {
      const apiKey = process.env.VITE_SHOPIFY_API_KEY;
      if (!apiKey) return html;
      return html.replace(
        '<head>',
        `<head>\n    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>`
      );
    },
  };
}

export default defineConfig({
  plugins: [vue(), shopifyAppBridge()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0',
    port: 8080,
    watch: {
      usePolling: true
    },
    hmr: {
      host: 'localhost',
      port: 8080
    },
    proxy: {
      '/api': {
        target: 'http://backend:3000',
        changeOrigin: true
      }
    }
  }
});
