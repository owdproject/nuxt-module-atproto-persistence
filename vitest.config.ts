import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  resolve: {
    alias: {
      '#imports': fileURLToPath(
        new URL('./test/nuxt-imports.ts', import.meta.url),
      ),
    },
  },
})
