import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { World, type WorldHandle } from './world/World'
import { useSpyMonster } from './useSpyMonster'
import type { MonsterId, Mood } from './types'
import { DirectorLink } from './components/DirectorLink'
import type { AudioStatus } from './audio/LibraryAudio'

const spirits: Record<MonsterId, { name: string; title: string; description: string }> = {
  sprout: { name: 'Sprout', title: 'The friendly one', description: 'A warm welcome in a very cold room. Sprout always seems to have something to say.' },
  pebble: { name: 'Pebble', title: 'The curious one', description: 'Every shelf has a secret. Pebble would very much like to hear yours.' },
  momo: { name: 'Momo', title: 'The quiet one', description: 'Momo says little, and notices more than you might think.' },
}

function Mark() {
  return <svg viewBox="0 0 32 38" fill="none" aria-hidden="true"><path d="M5 32V15a11 11 0 0 1 22 0v17l-5-3-6 5-6-5-5 3Z" stroke="currentColor" strokeWidth="1.4" /><ellipse cx="12" cy="16" rx="1.2" ry="2" fill="currentColor" /><ellipse cx="20" cy="16" rx="1.2" ry="2" fill="currentColor" /></svg>
}

function Arrow() { return <span aria-hidden="true">↗</span> }
const SOUND_PREFERENCE = 'spy-monster:sound-muted'
function savedMutePreference() {
  try { return localStorage.getItem(SOUND_PREFERENCE) === 'true' } catch { return false }
}
function SoundButton({ muted, toggle, compact = false }: { muted: boolean; toggle: () => void; compact?: boolean }) {
  return <button type="button" className={`sound-button ${compact ? 'compact' : ''}`} onClick={toggle} aria-label={muted ? 'Enable sound' : 'Mute sound'} aria-pressed={!muted} title={muted ? 'Enable sound' : 'Mute sound'}>
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />{muted ? <path d="m16 9 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.4" /> : <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>}</svg>
    {!compact && <span>Sound {muted ? 'off' : 'on'}</span>}
  </button>
}
function time(seconds: number | null) { const n = seconds ?? 180; return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}` }

function Modal({ title, label, children, close }: { title: string; label: string; children: ReactNode; close?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeRef.current) { e.stopPropagation(); closeRef.current() }
      if (e.key !== 'Tab') return
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, a[href], [tabindex="0"]') ?? [])
      if (!nodes.length) { e.preventDefault(); return }
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [])
  return <div className="modal-scrim"><div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
    {close && <button className="icon-button modal-close" onClick={close} aria-label="Close dialog">×</button>}
    <p className="eyebrow">{label}</p><h2>{title}</h2>{children}
  </div></div>
}

export default function App() {
  const world = useRef<WorldHandle>(null)
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001'
  const [soundMuted, setSoundMuted] = useState(savedMutePreference)
  // Mute silences the library sounds and every spoken line (witch clues and ghost replies).
  const game = useSpyMonster({ apiUrl, autoResume: true, voices: !soundMuted })
  const [mode, setMode] = useState<'lobby' | 'explore' | 'game'>('lobby')
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState(0)
  const [sceneError, setSceneError] = useState<string | null>(null)
  const [loadingKey, setLoadingKey] = useState(0)
  const [locked, setLocked] = useState(false)
  const [target, setTarget] = useState<MonsterId | null>(null)
  const [selected, setSelected] = useState<MonsterId | null>(null)
  const [paused, setPaused] = useState(false)
  const [journal, setJournal] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [dismissedResult, setDismissedResult] = useState(false)
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('locked')
  const [revealToken, setRevealToken] = useState(0)
  const [cinematicActive, setCinematicActive] = useState(false)
  const [revealShowing, setRevealShowing] = useState(false)
  const [revealPreview, setRevealPreview] = useState(false)
  const historyEnd = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousCue = useRef('')
  const gameMode = mode === 'game'
  const resultVisible = gameMode && game.isOver && !dismissedResult
  const overlay = mode === 'lobby' || paused || !!selected || journal || confirm || resultVisible || !!sceneError
  const moods: Partial<Record<MonsterId, Mood>> = {}
  if (gameMode) for (const monster of game.state?.monsters ?? []) moods[monster.id] = monster.mood

  game.useCue(cue => {
    if (cue.cue !== 'WITCH_REVEAL' || !gameMode) return
    const id = `${cue.cue}:${cue.at}`
    if (previousCue.current === id) return
    previousCue.current = id
    setPaused(false)
    setJournal(false)
    setRevealPreview(false)
    setRevealShowing(true)
    setRevealToken(token => token + 1)
    setToast('The witch has spoken. A new omen awaits.')
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 6500)
  })
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])
  useEffect(() => { if (overlay) world.current?.unlock() }, [overlay])
  useEffect(() => { try { localStorage.setItem(SOUND_PREFERENCE, String(soundMuted)) } catch {} }, [soundMuted])
  useEffect(() => { historyEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [game.messages, selected])

  function enableSound() { void world.current?.unlockAudio?.() }
  function toggleSound() { if (soundMuted) enableSound(); setSoundMuted(!soundMuted) }
  function meet(id: MonsterId) { setSelected(id); setMessage(''); setError(null); world.current?.unlock() }
  function explore() { enableSound(); flushSync(() => { setMode('explore'); setSelected(null); setPaused(false); setError(null) }); world.current?.lock() }
  async function startGame() {
    if (busy) return
    enableSound()
    setBusy(true); setError(null)
    try { await game.start(); setDismissedResult(false); setMode('game'); setSelected(null); setPaused(false); setJournal(false) }
    catch { setError('The game server is unavailable. You can still explore the library, or try again when it is online.') }
    finally { setBusy(false) }
  }
  function resumeGame() { enableSound(); flushSync(() => { setMode('game'); setDismissedResult(false); setPaused(false); setSelected(null); setError(null) }); world.current?.lock() }
  async function send(e: FormEvent) {
    e.preventDefault()
    const text = message.trim()
    if (!selected || !text || game.waitingFor || game.isOver) return
    setMessage('')
    await game.chat(selected, text)
  }
  async function accuse() {
    if (!selected || busy) return
    setBusy(true); setError(null)
    try { await game.accuse(selected); setConfirm(false); setSelected(null); setDismissedResult(false) }
    catch (err) { setError(err instanceof Error ? err.message : 'The accusation could not be submitted. Please try again.') }
    finally { setBusy(false) }
  }
  function backToLobby() { world.current?.unlock(); setMode('lobby'); setPaused(false); setSelected(null); setJournal(false); setConfirm(false); setError(null) }
  function previewWitch() {
    enableSound()
    setPaused(false); setSelected(null); setJournal(false); setRevealPreview(true); setRevealShowing(true)
    setRevealToken(token => token + 1)
  }
  const presentation = !gameMode || !game.state ? 'introduction' : game.state.phase === 'won' ? 'won' : game.state.phase !== 'playing' ? 'lost' : game.state.clues.length ? 'suspicion' : 'introduction'
  const sceneProps = { active: mode !== 'lobby' && !paused, interactive: !overlay, moods, doorOpen: gameMode && game.state?.phase === 'won', presentation, focusMonster: selected, revealToken, soundMuted, onAudioStatus: setAudioStatus, onCinematicChange: (active: boolean) => { setCinematicActive(active); if (!active) setRevealShowing(false) }, onProgress: setProgress, onReady: () => { setReady(true); setProgress(100) }, onError: setSceneError, onLockChange: setLocked, onTargetChange: setTarget, onInteract: meet } as const

  return <main className={`app mode-${mode}`} data-audio-status={audioStatus} data-sound-muted={soundMuted}>
    <World key={loadingKey} ref={world} {...sceneProps} />
    <div className="vignette" aria-hidden="true" />

    {mode === 'lobby' ? <section className="lobby" aria-label="Welcome to The Spy Monster">
      <div className="lobby-image" aria-hidden="true" />
      <div className="lobby-shade" aria-hidden="true" />
      <header className="lobby-header"><a href="#" className="wordmark" onClick={e => e.preventDefault()}><Mark /><span>HAUNTED HACKS</span></a><div className="lobby-tools"><SoundButton muted={soundMuted} toggle={toggleSound} /><DirectorLink apiUrl={apiUrl} sessionId={game.state?.sessionId} className="director-entry">Director View <Arrow /></DirectorLink></div></header>
      <div className="intro">
        <p className="eyebrow"><span className="fine-line" /> THE FORGOTTEN LIBRARY</p>
        <h1>The Spy<br /><em>Monster.</em></h1>
        <p className="intro-copy">Three spirits. One hidden traitor.<br />Find the secret before the library sees dawn.</p>
        <div className="intro-actions">
          <button className="button primary" disabled={!ready || !!sceneError} onClick={explore}>{ready ? 'Explore the library' : 'Opening the library…'}<Arrow /></button>
          {game.state?.phase === 'playing' ? <button className="button secondary" disabled={!ready} onClick={resumeGame}>Resume investigation <span>{time(game.secondsLeft)}</span></button> : <button className="button secondary" disabled={!ready || busy || !!sceneError} onClick={startGame}>{busy ? 'Connecting…' : 'Begin investigation'}<span>03:00</span></button>}
        </div>
        <p className="intro-note">Explore freely, or begin a three-minute game with the spirits.<span className="sound-hint">{soundMuted ? 'Sound is muted.' : 'Sound begins when you enter.'}</span></p>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {sceneError && <div className="inline-error" role="alert"><p>{sceneError}</p><button className="text-button" onClick={() => { setSceneError(null); setReady(false); setProgress(0); setLoadingKey(k => k + 1) }}>Retry loading ↗</button></div>}
        {!ready && !sceneError && <div className="load-progress" aria-label="Loading 3D library" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${Math.max(2, progress)}%` }} /><small>PREPARING THE SPACE <b>{Math.round(progress)}%</b></small></div>}
      </div>
      <footer className="lobby-footer"><span><i /> A place between candlelight and dawn.</span><span>WALK · LISTEN · SUSPECT</span></footer>
    </section> : <>
      <header className="hud-top">
        <button className="hud-brand" onClick={() => setPaused(true)} aria-label="Open menu"><Mark /><span>The Spy Monster<small>{gameMode ? 'THE INVESTIGATION' : 'THE FORGOTTEN LIBRARY'}</small></span></button>
        {gameMode ? <div className={`clock ${game.secondsLeft !== null && game.secondsLeft < 30 ? 'urgent' : ''}`} aria-label={`${game.secondsLeft} seconds until dawn`}><span>UNTIL DAWN</span><strong>{time(game.secondsLeft)}</strong><small>{game.state?.phase === 'playing' ? `ROUND ${game.state.round} · ${game.connected ? 'CONNECTED' : 'RECONNECTING'}` : game.state?.phase.toUpperCase()}</small></div> : <div className="exploration-label"><span className="status-dot" /> FREE EXPLORATION</div>}
        <div className="hud-top-actions"><SoundButton compact muted={soundMuted} toggle={toggleSound} />{!soundMuted && audioStatus === 'locked' && <button type="button" className="hud-button sound-resume" onClick={enableSound}>Resume sound</button>}{gameMode && <button className="hud-button" onClick={() => setJournal(true)}>Omens <span>{game.state?.clues.length ?? 0}</span></button>}<button className="icon-button menu-button" onClick={() => setPaused(true)} aria-label="Open pause menu"><span /><span /></button></div>
      </header>
      {!overlay && !cinematicActive && <>
        <div className={`reticle ${target ? 'has-target' : ''}`} aria-hidden="true"><span /><span /></div>
        {target && <button className="target-label" onClick={() => meet(target)}><span>{spirits[target].name}</span><small><kbd>E</kbd> Speak to the spirit</small></button>}
        <div className="objective"><p className="eyebrow">{gameMode ? 'FIND THE TRAITOR' : 'A MOMENT IN THE ARCHIVE'}</p><p>{gameMode ? 'Listen carefully. You have one accusation.' : 'Walk between the shelves. Meet the spirits.'}</p></div>
        <div className="controls-strip"><span><kbd>W A S D</kbd> Move</span><span><kbd>{locked ? 'MOUSE' : 'DRAG'}</kbd> Look</span><span><kbd>E</kbd> Speak</span><span><kbd>ESC</kbd> Cursor</span></div>
        {!locked && <button className="look-button" onClick={() => world.current?.lock()}>Click to look around <Arrow /></button>}
      </>}
      {revealShowing && <div className="witch-caption" role="status"><span>{revealPreview ? 'SCENE PREVIEW' : 'THE WITCH’S REVEAL'}</span><p>{revealPreview ? 'Something stirs beyond the shelves.' : game.state?.clues.at(-1)?.content || 'The witch has an omen for you.'}</p>{revealPreview && <small>A scene preview. Your investigation is unchanged.</small>}</div>}
      {toast && !revealShowing && <button className="omen-toast" role="status" onClick={() => { setJournal(true); setToast(null) }}><small>THE WITCH’S OMEN</small>{toast}<Arrow /></button>}
      {selected && !confirm && !resultVisible && !revealShowing && <aside className="dialogue-panel" aria-label={`Conversation with ${spirits[selected].name}`}>
        <div className="dialogue-heading"><div><p className="eyebrow">{spirits[selected].title}</p><h2>{spirits[selected].name}</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close conversation">×</button></div>
        <div className="dialogue-history" aria-live="polite">
          <p className="spirit-intro">{spirits[selected].description}</p>
          {gameMode ? game.messages.filter(line => line.monsterId === selected).map(line => <div className={`chat-line ${line.role}`} key={line.id}><small>{line.role === 'player' ? 'YOU' : spirits[selected].name.toUpperCase()}</small><p>{line.text}</p></div>) : <div className="explore-invitation"><span className="tiny-star">✧</span><p>Some stories only surface<br />when the investigation begins.</p><button className="button secondary" onClick={startGame} disabled={busy}>{busy ? 'Connecting…' : 'Begin investigation'}<Arrow /></button><small>Starts a live, three-minute game.</small></div>}
          {gameMode && game.waitingFor === selected && <p className="thinking" role="status">{spirits[selected].name} is thinking<span>…</span></p>}
          {(error || (gameMode && game.error)) && <p className="inline-error" role="alert">{error || game.error}</p>}<div ref={historyEnd} />
        </div>
        {gameMode && !game.isOver && <><form onSubmit={send} className="chat-form"><label className="sr-only" htmlFor="message">Ask {spirits[selected].name} a question</label><textarea id="message" rows={2} maxLength={300} value={message} onChange={e => setMessage(e.target.value)} placeholder="What aren’t you telling me?" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e) } }} /><div><small>{message.length}/300</small><button type="submit" aria-label="Send message" disabled={!message.trim() || !!game.waitingFor}>Send ↗</button></div></form><button className="accuse-button" onClick={() => setConfirm(true)} disabled={busy || !!game.state?.accusation}>I think you’re the spy <span>→</span></button></>}
      </aside>}
    </>}

    {paused && <Modal label="TAKE A BREATH" title="The library waits." close={() => setPaused(false)}><p>{gameMode && !game.isOver ? 'The investigation clock keeps running while you are here.' : 'The shelves have kept their secrets for centuries. You have time.'}</p><div className="menu-actions"><button className="button primary" onClick={() => { enableSound(); flushSync(() => setPaused(false)); world.current?.lock() }}>Return to the library <Arrow /></button><button className="button secondary" onClick={() => { world.current?.reset(); setPaused(false) }}>Return to entrance <span>↺</span></button>{mode === 'explore' && <button className="button secondary" onClick={previewWitch}>Preview the witch’s reveal <span>✧</span></button>}<DirectorLink apiUrl={apiUrl} sessionId={game.state?.sessionId} className="button secondary" label="Open Director View">Open Director View <Arrow /></DirectorLink><button className="text-button" onClick={backToLobby}>Back to title</button></div><div className="menu-sound"><div><span>Library atmosphere</span><small>Distant knocks, strained timber and the witch’s arrival.</small></div><SoundButton muted={soundMuted} toggle={toggleSound} /></div>{mode !== 'lobby' && !soundMuted && audioStatus === 'locked' && <p className="audio-note" role="status">Sound is paused.<button type="button" className="text-button" onClick={enableSound}>Resume sound</button></p>}{!soundMuted && audioStatus === 'loading' && <p className="audio-note" role="status">Preparing sound…</p>}{audioStatus === 'unavailable' && <p className="audio-note" role="status">Sound is unavailable. You can keep exploring.<button type="button" className="text-button" onClick={enableSound}>Try sound again</button></p>}<div className="menu-controls"><p><kbd>W A S D</kbd> Walk &nbsp; <kbd>SHIFT</kbd> Walk faster</p><p><kbd>MOUSE / DRAG</kbd> Look &nbsp; <kbd>E</kbd> Speak</p><p>On touchscreens, use the movement pad and drag to look.</p></div></Modal>}
    {journal && <Modal label="THE WITCH’S OMENS" title="What the walls heard." close={() => setJournal(false)}><div className="journal-list">{game.state?.clues.length ? game.state.clues.map(clue => <article key={clue.id}><p className="eyebrow">ROUND {clue.round}</p><p>“{clue.content}”</p></article>) : <p>No omen has been revealed yet. Keep talking to the spirits.</p>}</div>{game.secondsToReveal !== null && !game.isOver && <p className="journal-next">Next whisper in {time(game.secondsToReveal)}</p>}</Modal>}
    {confirm && selected && <Modal label="ONE CHANCE TO LEAVE" title={`Accuse ${spirits[selected].name}?`} close={busy ? undefined : () => setConfirm(false)}><p>You have one accusation. Choose correctly and the door opens. Choose wrongly and the witch keeps you.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="menu-actions"><button className="button danger" onClick={accuse} disabled={busy}>{busy ? 'Waiting for the verdict…' : `Accuse ${spirits[selected].name}`}<Arrow /></button><button className="text-button" onClick={() => setConfirm(false)} disabled={busy}>I need more time</button></div></Modal>}
    {resultVisible && <Modal label={game.state?.phase === 'won' ? 'THE LOCK HAS TURNED' : 'THE LAST CANDLE FADES'} title={game.state?.phase === 'won' ? 'You found a way out.' : game.state?.phase === 'expired' ? 'Dawn came too soon.' : 'A secret kept you here.'}><p>{game.state?.spyId ? `${spirits[game.state.spyId].name} was the witch’s spy.` : 'The investigation has ended.'} {game.state?.phase === 'won' ? 'The escape door is now open.' : 'Every conversation left a trace. Look back through the evidence.'}</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="menu-actions"><DirectorLink apiUrl={apiUrl} sessionId={game.state?.sessionId} className="button primary" label="Open Director View">Open Director View <Arrow /></DirectorLink><button className="button secondary" onClick={() => setDismissedResult(true)}>Return to the room <Arrow /></button><button className="text-button" onClick={backToLobby}>Back to title</button></div></Modal>}
    {sceneError && mode !== 'lobby' && <Modal label="SCENE INTERRUPTED" title="Let’s reopen the library."><p>{sceneError}</p><button className="button primary" onClick={() => { backToLobby(); setSceneError(null); setReady(false); setProgress(0); setLoadingKey(k => k + 1) }}>Reload the scene <span>↺</span></button></Modal>}
  </main>
}
