import { useEffect, useRef } from 'react'
import { DirectorLink } from './DirectorLink'
import './escape.css'

interface EscapeScreenProps {
  apiUrl: string
  sessionId?: string
  spyName?: string
  busy: boolean
  ready: boolean
  error: string | null
  onPlayAgain: () => void
  onBackToTitle: () => void
}

export function EscapeScreen({ apiUrl, sessionId, spyName, busy, ready, error, onPlayAgain, onBackToTitle }: EscapeScreenProps) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])

  return <section className="escape-screen" aria-labelledby="escape-title">
    <header className="escape-header"><span>THE FORGOTTEN LIBRARY</span><span>INVESTIGATION COMPLETE</span></header>
    <div className="escape-content">
      <p className="eyebrow"><span className="fine-line" aria-hidden="true" /> THE FIRST LIGHT</p>
      <h1 id="escape-title" tabIndex={-1} ref={heading}>You<br /><em>escaped.</em></h1>
      <p className="escape-copy">The library is behind you.<br />The witch’s hold is broken.</p>
      {spyName && <p className="escape-truth">The witch’s spy was <strong>{spyName}</strong>.</p>}
      <div className="escape-actions">
        <button type="button" className="button primary" disabled={!ready || busy} onClick={onPlayAgain}>{busy ? 'Starting investigation…' : 'Play again'}<span aria-hidden="true">↗</span></button>
        <DirectorLink apiUrl={apiUrl} sessionId={sessionId} className="button secondary" label="Open Director View">Open Director View <span aria-hidden="true">↗</span></DirectorLink>
        <button type="button" className="text-button escape-back" disabled={busy} onClick={onBackToTitle}>Back to title</button>
      </div>
      {busy && <p className="sr-only" role="status">Starting a new investigation.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <footer className="escape-footer"><span className="fine-line" aria-hidden="true" />The whispers end here.</footer>
  </section>
}
