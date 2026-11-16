/**
 * Builds the iPhone app's web layer into ONE self-contained index.html
 * (ios/RemoteAgent/web/index.html). A WKWebView loading a file:// page cannot
 * fetch sibling module scripts, so everything is inlined; the result is
 * committed, which means building the app on a Mac needs Xcode only — no Node.
 */
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const root = resolve(__dirname, '../..')

function inlineEverything(): Plugin {
  return {
    name: 'ra-inline-everything',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (f) => f.type === 'asset' && f.fileName.endsWith('.html')
      )
      if (!html || html.type !== 'asset') return
      let source = String(html.source)
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk') {
          // a literal "</script" inside the code would end the inline element early
          const code = file.code.replace(/<\/script/gi, '<\\/script')
          const tag = new RegExp(`<script[^>]*src="[^"]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*></script>`)
          if (tag.test(source)) {
            source = source.replace(tag, () => `<script type="module">${code}</script>`)
            delete bundle[name]
          }
        } else if (name.endsWith('.css')) {
          const tag = new RegExp(`<link[^>]*href="[^"]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`)
          if (tag.test(source)) {
            source = source.replace(tag, () => `<style>${String(file.source)}</style>`)
            delete bundle[name]
          }
        }
      }
      html.source = source
    }
  }
}

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), inlineEverything()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@': resolve(root, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(root, 'ios/RemoteAgent/web'),
    emptyOutDir: true,
    target: 'safari15',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    rollupOptions: {
      output: { inlineDynamicImports: true }
    }
  }
})
