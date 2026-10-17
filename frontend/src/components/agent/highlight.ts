import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

const highlighter = createHighlighterCore({
  themes: [import('shiki/themes/github-light.mjs')],
  langs: [import('shiki/langs/cpp.mjs')],
  engine: createOnigurumaEngine(import('shiki/wasm')),
})

export async function highlightCpp(code: string) {
  return (await highlighter).codeToHtml(code, {
    lang: 'cpp', theme: 'github-light',
    colorReplacements: {
      '#24292e': 'var(--foreground)',
      '#6a737d': 'var(--muted-foreground)',
    },
  })
}
