import { useEffect, useState } from 'react'
import { diffLines } from 'diff'

// No matching registry code/diff viewer was found. Shiki owns syntax tokenization;
// this domain view connects it to the selected attempt and a safe text-only diff.
export function CodeReadout({ code, previous, showDiff }: { code: string; previous?: string; showDiff: boolean }) {
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null)
  const [highlightError, setHighlightError] = useState(false)
  useEffect(() => {
    let cancelled = false
    setHighlightError(false)
    import('./highlight').then(module => module.highlightCpp(code)).then(html => {
      if (!cancelled) setHighlighted({ code, html })
    }).catch(() => { if (!cancelled) setHighlightError(true) })
    return () => { cancelled = true }
  }, [code])

  if (showDiff && previous !== undefined) return <div className="code-readout diff-readout" aria-label="Changes from previous attempt">
    <pre><code>{diffLines(previous, code).map((part, index) => <span key={index} className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-context'}>
      {part.value.replace(/\n$/, '').split('\n').map((line, lineIndex) => <span className="diff-line" key={lineIndex}>
        <span className="diff-marker" aria-label={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'}>{part.added ? '+' : part.removed ? '−' : ' '}</span>{line}{'\n'}
      </span>)}
    </span>)}</code></pre>
  </div>
  return <div className="code-readout" aria-label="C++ sketch">
    {highlighted?.code === code
      ? <div dangerouslySetInnerHTML={{ __html: highlighted.html }} />
      : <pre><code>{code}</code></pre>}
    {highlightError && <p className="caption">Syntax highlighting could not load. Showing plain code.</p>}
  </div>
}
