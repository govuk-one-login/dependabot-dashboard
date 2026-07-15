import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 3010,
    proxy: {
      '/api': {
        target: 'http://localhost:3011',
        changeOrigin: true
      }
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        includePaths: [
          path.resolve(__dirname, 'node_modules')
        ],
        silenceDeprecations: [
          'import',
          'global-builtin',
          'color-functions',
          'slash-div',
          'if-function',
        ],
        quietDeps: true
      }
    },
    lightningcss: {
      errorRecovery: true
    }
  }
})
