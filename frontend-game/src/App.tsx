import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { World, type WorldHandle } from './world/World'
import { useSpyMonster } from './useSpyMonster'
import type { MonsterId, Mood } from './types'
import { DirectorLink } from './components/DirectorLink'
import { EscapeScreen } from './components/EscapeScreen'
import type { AudioStatus } from './audio/LibraryAudio'
import { canRecord, startRecording, type Recording } from './audio/recorder'
import { GameApiError } from './api'
import { dueScare, scareSchedule } from './scares'

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
const MAX_RECORDING_MS = 15_000
function micError(err: unknown) {
  const code = err instanceof GameApiError ? err.code : ''
  if (code === 'voice_unavailable') return 'Voice needs the server’s OpenAI key. You can still type.'
  if (code === 'no_speech') return 'The spirit heard only silence. Try again.'
  return 'Your words were lost in the dark. Try again, or type instead.'
}
function playedScares(key: string): number[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(value) ? value.filter(Number.isInteger) : [] } catch { return [] }
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

// ?demo in the URL runs a short round for live demos: 90 seconds, a witch clue every 30 seconds.
const DEMO_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')

type Board = {
  totals: { games: number; escape_rate_pct: number | null; fastest_catch_seconds: number | null; total_whispers: number } | null
  monsters: { monster: MonsterId; times_spy: number; got_away_pct: number | null }[]
  disabled?: boolean
}

// All-games stats, archived to Supabase by the game server.
function Leaderboard({ apiUrl, close }: { apiUrl: string; close: () => void }) {
  const [board, setBoard] = useState<Board | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetch(`${apiUrl.replace(/\/$/, '')}/api/leaderboard`).then(r => r.json()).then((b: Board) => live && setBoard(b)).catch(() => live && setFailed(true))
    return () => { live = false }
  }, [apiUrl])
  const t = board?.totals
  const top = board?.monsters[0]
  const stats: [string, string][] = t ? [
    ['Games played', String(t.games)],
    ['Players escaped', t.escape_rate_pct === null ? '-' : `${t.escape_rate_pct}%`],
    ['Fastest catch', t.fastest_catch_seconds === null ? '-' : time(t.fastest_catch_seconds)],
    ['Most deceptive', top ? `${spirits[top.monster]?.name ?? top.monster}` : '-'],
  ] : []
  return <Modal label="EVERY GAME SO FAR" title="The library remembers." close={close}>
    {failed || board?.disabled ? <p>The leaderboard is resting. Play a game and check back.</p>
      : !t ? <p role="status">Opening the records…</p>
      : <>
        <div className="board-stats">{stats.map(([label, value]) => <div className="card3d board-stat" key={label}><p className="step-num">{label}</p><p className="board-value">{value}</p></div>)}</div>
        {top && <p className="board-note">{spirits[top.monster]?.name ?? top.monster} got away {top.got_away_pct ?? 0}% of the times it was the spy. {t.total_whispers} whispers have passed between the ghosts.</p>}
      </>}
  </Modal>
}

export default function App() {
  const world = useRef<WorldHandle>(null)
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001'
  const [soundMuted, setSoundMuted] = useState(savedMutePreference)
  const [mode, setMode] = useState<'lobby' | 'explore' | 'game' | 'escaped'>('lobby')
  // Crossing the courtyard ends both room sounds and any queued spoken lines.
  const game = useSpyMonster({ apiUrl, autoResume: true, voices: !soundMuted && mode !== 'escaped' })
  const [boardOpen, setBoardOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState(0)
  const [sceneError, setSceneError] = useState<string | null>(null)
  const [loadingKey, setLoadingKey] = useState(0)
  const [locked, setLocked] = useState(false)
  const [target, setTarget] = useState<MonsterId | null>(null)
  const [selected, setSelected] = useState<MonsterId | null>(null)
  const [listening, setListening] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const recording = useRef<{ recording: Recording; monsterId: MonsterId; timer: ReturnType<typeof setTimeout> } | null>(null)
  const micSession = useRef(0)
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
  const [scareToken, setScareToken] = useState(0)
  const [revealPreview, setRevealPreview] = useState(false)
  const historyEnd = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousCue = useRef('')
  const gameMode = mode === 'game'
  const won = game.state?.phase === 'won'
  const escaped = mode === 'escaped'
  const resultVisible = gameMode && game.isOver && !dismissedResult
  const overlay = mode === 'lobby' || escaped || boardOpen || paused || !!selected || journal || confirm || resultVisible || !!sceneError
  const moods: Partial<Record<MonsterId, Mood>> = {}
  if (gameMode) for (const monster of game.state?.monsters ?? []) moods[monster.id] = monster.mood

  game.useCue(cue => {
    if (cue.cue !== 'WITCH_REVEAL' || !gameMode || game.isOver) return
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
  // Leaving a conversation drops an unfinished spoken question.
  useEffect(() => () => {
    micSession.current++
    if (recording.current) { clearTimeout(recording.current.timer); recording.current.recording.cancel(); recording.current = null }
    setListening('idle')
  }, [selected])
  // The witch's surprise glimpses: two or three per game, never during her reveal or a menu.
  const scareBlocked = mode !== 'game' || game.isOver || paused || journal || confirm || cinematicActive || revealShowing || !ready || (game.secondsToReveal !== null && game.secondsToReveal <= 8)
  useEffect(() => {
    const state = game.state
    if (!state || state.phase !== 'playing' || scareBlocked || document.hidden) return
    const key = `spy-monster:scares:${state.sessionId}`
    const played = playedScares(key)
    const index = dueScare(scareSchedule(state.sessionId, state.startedAt, state.deadlineAt), played, Date.now() + game.clockOffsetMs, false)
    if (index === null) return
    try { localStorage.setItem(key, JSON.stringify([...played, index])) } catch {}
    setScareToken(token => token + 1)
  }, [game.secondsLeft, scareBlocked])
  useEffect(() => { historyEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [game.messages, selected])

  function clearRoomUi() {
    world.current?.unlock()
    setPaused(false); setSelected(null); setJournal(false); setConfirm(false); setBoardOpen(false)
    setError(null); setMessage(''); setToast(null); setTarget(null)
    setRevealShowing(false); setRevealPreview(false); previousCue.current = ''
    micSession.current++
    if (recording.current) {
      clearTimeout(recording.current.timer); recording.current.recording.cancel(); recording.current = null
    }
    setListening('idle')
    if (toastTimer.current) { clearTimeout(toastTimer.current); toastTimer.current = null }
  }
  function walkToExit() {
    if (!gameMode || !won) return
    enableSound()
    flushSync(() => { clearRoomUi(); setDismissedResult(true) })
    world.current?.guideToExit()
    world.current?.lock()
  }
  // Only World calls this after the player actually walks beyond the open doorway.
  function finishEscape() {
    if (!gameMode || !won) return
    clearRoomUi()
    setMode('escaped')
  }
  function enableSound() { void world.current?.unlockAudio?.() }
  function toggleSound() { if (soundMuted) enableSound(); setSoundMuted(!soundMuted) }
  function meet(id: MonsterId) { setSelected(id); setMessage(''); setError(null); world.current?.unlock() }
  function explore() { enableSound(); flushSync(() => { setMode('explore'); setSelected(null); setPaused(false); setError(null) }); world.current?.lock() }
  async function startGame() {
    if (busy) return
    enableSound()
    setBusy(true); setError(null)
    try { await game.start(DEMO_MODE ? { gameSeconds: 90, revealSeconds: 30 } : undefined); clearRoomUi(); world.current?.reset(); setDismissedResult(false); setMode('game') }
    catch { setError(escaped ? 'A new investigation could not start. Your escape is saved; try again or view the completed investigation.' : 'The game server is unavailable. You can still explore the library, or try again when it is online.') }
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
  async function toggleMic() {
    if (listening === 'recording') return finishRecording()
    if (!selected || listening !== 'idle' || game.waitingFor || game.isOver) return
    setError(null)
    const session = ++micSession.current
    try {
      const started = await startRecording()
      if (session !== micSession.current) return started.cancel()
      recording.current = { recording: started, monsterId: selected, timer: setTimeout(() => void finishRecording(), MAX_RECORDING_MS) }
      setListening('recording')
    } catch { if (session === micSession.current) setError('Microphone access was blocked. You can still type.') }
  }
  async function finishRecording() {
    const current = recording.current
    if (!current) return
    recording.current = null
    clearTimeout(current.timer)
    const session = micSession.current
    setListening('transcribing')
    try {
      const text = await game.transcribe(await current.recording.stop())
      if (session !== micSession.current) return
      setListening('idle')
      await game.chat(current.monsterId, text)
    } catch (err) {
      if (session !== micSession.current) return
      setListening('idle'); setError(micError(err))
    }
  }
  async function accuse() {
    if (!selected || busy) return
    setBusy(true); setError(null)
    try { await game.accuse(selected); setConfirm(false); setSelected(null); setDismissedResult(false) }
    catch (err) { setError(err instanceof Error ? err.message : 'The accusation could not be submitted. Please try again.') }
    finally { setBusy(false) }
  }
  function backToLobby() { clearRoomUi(); setMode('lobby') }
  function previewWitch() {
    enableSound()
    setPaused(false); setSelected(null); setJournal(false); setRevealPreview(true); setRevealShowing(true)
    setRevealToken(token => token + 1)
  }
  const presentation = escaped ? 'won' : !gameMode || !game.state ? 'introduction' : game.state.phase === 'won' ? 'won' : game.state.phase !== 'playing' ? 'lost' : game.state.clues.length ? 'suspicion' : 'introduction'
  const sceneProps = { active: (mode === 'explore' || gameMode) && !paused, interactive: !overlay, moods, doorOpen: (gameMode || escaped) && won, presentation, focusMonster: selected, revealToken, scareToken, soundMuted, onAudioStatus: setAudioStatus, onCinematicChange: (active: boolean) => { setCinematicActive(active); if (!active) setRevealShowing(false) }, onProgress: setProgress, onReady: () => { setReady(true); setProgress(100) }, onError: setSceneError, onLockChange: setLocked, onTargetChange: setTarget, onInteract: meet, onEscaped: finishEscape } as const

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
        <p className="intro-lede">Three ghosts. One secretly reports to the witch. <strong>Catch the spy before dawn.</strong></p>
        <div className="intro-actions">
          {game.state?.phase === 'playing'
            ? <button className="btn3d btn3d-primary" disabled={!ready} onClick={resumeGame}>Resume investigation <span className="btn3d-time">{time(game.secondsLeft)}</span></button>
            : <button className="btn3d btn3d-primary" disabled={!ready || busy || !!sceneError} onClick={startGame}>{busy ? 'Connecting…' : ready ? 'Begin investigation' : 'Opening the library…'}<span className="btn3d-time">{DEMO_MODE ? '1:30' : '3:00'}</span></button>}
          <button className="btn3d btn3d-secondary" onClick={() => setBoardOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 20V11M12 20V5M18 20v-6" /></svg>Leaderboard</button>
        </div>
        <p className="intro-sound"><span className="icon-chip small" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></svg></span>{soundMuted ? 'Sound is muted. Turn it on: the witch speaks.' : 'Turn your sound on. The witch speaks.'}</p>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {sceneError && <div className="inline-error" role="alert"><p>{sceneError}</p><button className="text-button" onClick={() => { setSceneError(null); setReady(false); setProgress(0); setLoadingKey(k => k + 1) }}>Retry loading ↗</button></div>}
        {!ready && !sceneError && <div className="load-progress" aria-label="Loading 3D library" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${Math.max(2, progress)}%` }} /><small>PREPARING THE SPACE <b>{Math.round(progress)}%</b></small></div>}
      </div>
      <footer className="lobby-footer"><span><i /> Live AI ghosts · Real agent-to-agent whispers</span><span>TERSE · AGENT RELAY · OPENAI · SUPABASE</span></footer>
      {boardOpen && <Leaderboard apiUrl={apiUrl} close={() => setBoardOpen(false)} />}
    </section> : escaped ? <EscapeScreen apiUrl={apiUrl} sessionId={game.state?.sessionId} spyName={game.state?.spyId ? spirits[game.state.spyId].name : undefined} busy={busy} ready={ready && !sceneError} error={error} onPlayAgain={startGame} onBackToTitle={backToLobby} /> : <>
      <header className="hud-top">
        <button className="hud-brand" onClick={() => setPaused(true)} aria-label="Open menu"><Mark /><span>The Spy Monster<small>{gameMode ? 'THE INVESTIGATION' : 'THE FORGOTTEN LIBRARY'}</small></span></button>
        {gameMode && !game.isOver ? <div className={`clock ${game.secondsLeft !== null && game.secondsLeft < 30 ? 'urgent' : ''}`} aria-label={`${game.secondsLeft} seconds until dawn`}><span>UNTIL DAWN</span><strong>{time(game.secondsLeft)}</strong><small>{game.state?.phase === 'playing' ? `ROUND ${game.state.round} · ${game.connected ? 'CONNECTED' : 'RECONNECTING'}` : game.state?.phase.toUpperCase()}</small></div> : <div className="exploration-label"><span className="status-dot" /> {gameMode ? won ? 'THE WAY OUT IS OPEN' : 'INVESTIGATION ENDED' : 'FREE EXPLORATION'}</div>}
        <div className="hud-top-actions"><SoundButton compact muted={soundMuted} toggle={toggleSound} />{!soundMuted && audioStatus === 'locked' && <button type="button" className="hud-button sound-resume" onClick={enableSound}>Resume sound</button>}{gameMode && won && <button className="hud-button exit-library-button" onClick={walkToExit}>Find the exit <Arrow /></button>}{gameMode && !game.isOver && <button className="hud-button" onClick={() => setJournal(true)}>Omens <span>{game.state?.clues.length ?? 0}</span></button>}<button className="icon-button menu-button" onClick={() => setPaused(true)} aria-label="Open pause menu"><span /><span /></button></div>
      </header>
      {!overlay && !cinematicActive && <>
        <div className={`reticle ${target ? 'has-target' : ''}`} aria-hidden="true"><span /><span /></div>
        {target && <button className="target-label" onClick={() => meet(target)}><span>{spirits[target].name}</span><small><kbd>E</kbd> Speak to the spirit</small></button>}
        <div className="objective"><p className="eyebrow">{gameMode ? game.isOver ? won ? 'WALK INTO THE DAYLIGHT' : 'THE INVESTIGATION HAS ENDED' : 'FIND THE TRAITOR' : 'A MOMENT IN THE ARCHIVE'}</p><p>{gameMode ? game.isOver ? won ? 'Walk through the open door and follow the courtyard path.' : 'Review the evidence in Director View, or return to the title.' : 'Listen carefully. You have one accusation.' : 'Walk between the shelves. Meet the spirits.'}</p></div>
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
          {gameMode && listening !== 'idle' && <p className="thinking" role="status">{listening === 'recording' ? `${spirits[selected].name} is listening` : 'Catching your words'}<span>…</span></p>}
          {gameMode && game.waitingFor === selected && <p className="thinking" role="status">{spirits[selected].name} is thinking<span>…</span></p>}
          {(error || (gameMode && game.error)) && <p className="inline-error" role="alert">{error || game.error}</p>}<div ref={historyEnd} />
        </div>
        {gameMode && !game.isOver && <><form onSubmit={send} className="chat-form"><label className="sr-only" htmlFor="message">Ask {spirits[selected].name} a question</label><textarea id="message" rows={2} maxLength={300} value={message} onChange={e => setMessage(e.target.value)} placeholder="What aren’t you telling me?" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e) } }} /><div><small>{message.length}/300</small><span className="chat-actions">{canRecord() && <button type="button" className={`mic-button ${listening}`} onClick={() => void toggleMic()} disabled={listening === 'transcribing' || !!game.waitingFor} aria-pressed={listening === 'recording'} aria-label={listening === 'recording' ? 'Stop and send your question' : `Speak to ${spirits[selected].name}`}>{listening === 'recording' ? <><i aria-hidden="true" />Stop</> : <><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.6" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>{listening === 'transcribing' ? 'Listening…' : 'Speak'}</>}</button>}<button type="submit" aria-label="Send message" disabled={!message.trim() || !!game.waitingFor || listening !== 'idle'}>Send ↗</button></span></div></form><button className="accuse-button" onClick={() => setConfirm(true)} disabled={busy || !!game.state?.accusation}>I think you’re the spy <span>→</span></button></>}
      </aside>}
    </>}

    {paused && <Modal label="TAKE A BREATH" title="The library waits." close={() => setPaused(false)}><p>{gameMode && !game.isOver ? 'The investigation clock keeps running while you are here.' : 'The shelves have kept their secrets for centuries. You have time.'}</p><div className="menu-actions">{gameMode && won && <button className="button primary" onClick={walkToExit}>Walk to the exit <Arrow /></button>}<button className={`button ${gameMode && won ? 'secondary' : 'primary'}`} onClick={() => { enableSound(); flushSync(() => setPaused(false)); world.current?.lock() }}>Return to the library <Arrow /></button><button className="button secondary" onClick={() => { world.current?.reset(); setPaused(false) }}>Return to entrance <span>↺</span></button>{mode === 'explore' && <button className="button secondary" onClick={previewWitch}>Preview the witch’s reveal <span>✧</span></button>}<DirectorLink apiUrl={apiUrl} sessionId={game.state?.sessionId} className="button secondary" label="Open Director View">Open Director View <Arrow /></DirectorLink><button className="text-button" onClick={backToLobby}>Back to title</button></div><div className="menu-sound"><div><span>Library atmosphere</span><small>Distant knocks, strained timber and the witch’s arrival.</small></div><SoundButton muted={soundMuted} toggle={toggleSound} /></div>{mode !== 'lobby' && !soundMuted && audioStatus === 'locked' && <p className="audio-note" role="status">Sound is paused.<button type="button" className="text-button" onClick={enableSound}>Resume sound</button></p>}{!soundMuted && audioStatus === 'loading' && <p className="audio-note" role="status">Preparing sound…</p>}{audioStatus === 'unavailable' && <p className="audio-note" role="status">Sound is unavailable. You can keep exploring.<button type="button" className="text-button" onClick={enableSound}>Try sound again</button></p>}<div className="menu-controls"><p><kbd>W A S D</kbd> Walk &nbsp; <kbd>SHIFT</kbd> Walk faster</p><p><kbd>MOUSE / DRAG</kbd> Look &nbsp; <kbd>E</kbd> Speak</p><p>On touchscreens, use the movement pad and drag to look.</p></div></Modal>}
    {journal && <Modal label="THE WITCH’S OMENS" title="What the walls heard." close={() => setJournal(false)}><div className="journal-list">{game.state?.clues.length ? game.state.clues.map(clue => <article key={clue.id}><p className="eyebrow">ROUND {clue.round}</p><p>“{clue.content}”</p></article>) : <p>No omen has been revealed yet. Keep talking to the spirits.</p>}</div>{game.secondsToReveal !== null && !game.isOver && <p className="journal-next">Next whisper in {time(game.secondsToReveal)}</p>}</Modal>}
    {confirm && selected && <Modal label="ONE CHANCE TO LEAVE" title={`Accuse ${spirits[selected].name}?`} close={busy ? undefined : () => setConfirm(false)}><p>You have one accusation. Choose correctly and the door opens. Choose wrongly and the witch keeps you.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="menu-actions"><button className="button danger" onClick={accuse} disabled={busy}>{busy ? 'Waiting for the verdict…' : `Accuse ${spirits[selected].name}`}<Arrow /></button><button className="text-button" onClick={() => setConfirm(false)} disabled={busy}>I need more time</button></div></Modal>}
    {resultVisible && <Modal label={game.state?.phase === 'won' ? 'THE LOCK HAS TURNED' : 'THE LAST CANDLE FADES'} title={game.state?.phase === 'won' ? 'You found a way out.' : game.state?.phase === 'expired' ? 'Dawn came too soon.' : 'A secret kept you here.'}><p>{game.state?.spyId ? `${spirits[game.state.spyId].name} was the witch’s spy.` : 'The investigation has ended.'} {game.state?.phase === 'won' ? 'The door is open. Walk through it into the courtyard to escape.' : 'Every conversation left a trace. Look back through the evidence.'}</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="menu-actions">{won && <button className="button primary" onClick={walkToExit}>Walk to the exit <Arrow /></button>}<DirectorLink apiUrl={apiUrl} sessionId={game.state?.sessionId} className={`button ${won ? 'secondary' : 'primary'}`} label="Open Director View">Open Director View <Arrow /></DirectorLink><button className={won ? 'text-button' : 'button secondary'} onClick={() => setDismissedResult(true)}>{won ? 'Stay a little longer' : 'Return to the room'} <Arrow /></button>{!won && <button className="text-button" onClick={backToLobby}>Back to title</button>}</div></Modal>}
    {sceneError && mode !== 'lobby' && <Modal label="SCENE INTERRUPTED" title="Let’s reopen the library."><p>{sceneError}</p><button className="button primary" onClick={() => { backToLobby(); setSceneError(null); setReady(false); setProgress(0); setLoadingKey(k => k + 1) }}>Reload the scene <span>↺</span></button></Modal>}
  </main>
}
