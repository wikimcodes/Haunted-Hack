export type AudioStatus = "locked" | "loading" | "ready" | "unavailable"
export interface AudioFrame {
    active: boolean
    muted: boolean
    reveal: { token: number; elapsed: number; strength: number } | null
    /** Subtle left/right placement of the window, relative to the current camera. */
    pan?: number
}
interface Options {
    baseUrl: string
    onStatus?: (status: AudioStatus) => void
    createContext?: () => AudioContext
    fetchAudio?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>
}
type Voice = { source: AudioBufferSourceNode; gain: GainNode; clock: number; offset: number; token?: number }
const FADE_SECONDS = .035
const REVEAL_SECONDS = 6
const SOUND_REVISION = "elevenlabs-1"

/** Make space for the arrival: near silence, impact, then a slow return to the room. */
function atmosphereLevel(elapsed: number | undefined): number {
    const normal = .62
    if (elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= REVEAL_SECONDS) return normal
    const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t) }
    if (elapsed < .12) return normal * (1 - .96 * smooth(elapsed / .12))
    if (elapsed < .72) return normal * .04
    if (elapsed < 1.15) return normal * (.04 + .14 * smooth((elapsed - .72) / .43))
    if (elapsed < 4.6) return normal * (.18 + .12 * smooth((elapsed - 1.15) / 3.45))
    return normal * (.30 + .70 * smooth((elapsed - 4.6) / 1.4))
}

/** One scene's audio. Context creation/resume happens only through an explicit user gesture. */
export class LibraryAudio {
    private context: AudioContext | null = null
    private master: GainNode | null = null
    private roomGain: GainNode | null = null
    private revealGain: GainNode | null = null
    private panner: StereoPannerNode | null = null
    private buffers: { room: AudioBuffer; reveal: AudioBuffer } | null = null
    private room: Voice | null = null
    private reveal: Voice | null = null
    private roomOffset = 0
    private highestToken = 0
    private finishedToken = -1
    private roomLevel = -1
    private currentPan = -2
    private loading: Promise<void> | null = null
    private requested = false
    private hidden = false
    private disposed = false
    private failed = false
    private status: AudioStatus = "locked"
    private abort = new AbortController()
    private frame: AudioFrame = { active: false, muted: false, reveal: null }

    constructor(private options: Options) {}

    /** Call directly in a click handler, before its first await. */
    async unlock(): Promise<boolean> {
        if (this.disposed) return false
        try {
            if (!this.context) {
                const create = this.options.createContext ?? (() => {
                    const Constructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
                    if (!Constructor) throw new Error("Web Audio unavailable")
                    return new Constructor()
                })
                const ctx = this.context = create()
                this.master = ctx.createGain(); this.master.gain.value = .8; this.master.connect(ctx.destination)
                this.roomGain = ctx.createGain(); this.roomGain.gain.value = 0; this.roomGain.connect(this.master)
                this.revealGain = ctx.createGain(); this.revealGain.gain.value = .9; this.revealGain.connect(this.master)
                this.panner = ctx.createStereoPanner(); this.panner.connect(this.revealGain)
                ctx.onstatechange = () => { if (!this.disposed) { this.reportStatus(); this.reconcile() } }
            }
            this.requested = true
            // Resume before fetching/decoding, while the browser still has the click's activation.
            const resumed = this.context.resume()
            if (this.failed) { this.failed = false; this.loading = null }
            void this.load()
            await resumed
            if (this.disposed) return false
            this.reportStatus(); this.reconcile()
            return this.context.state === "running"
        } catch {
            if (!this.disposed) {
                if (!this.context) this.failed = true
                this.reportStatus(); this.stopVoices()
            }
            return false
        }
    }

    update(frame: AudioFrame): void {
        if (this.disposed) return
        this.frame = frame
        if (frame.reveal && Number.isFinite(frame.reveal.token)) this.highestToken = Math.max(this.highestToken, frame.reveal.token)
        this.reconcile()
    }

    setHidden(hidden: boolean): void {
        if (this.disposed) return
        this.hidden = hidden
        if (hidden) this.stopVoices()
        else if (this.requested && this.context?.state === "suspended") {
            // Previously enabled sound may be interrupted by the OS. A rejected resume stays locked.
            void this.context.resume().then(() => { this.reportStatus(); this.reconcile() }).catch(() => this.reportStatus())
        }
        this.reconcile()
    }

    private reportStatus(): void {
        if (this.disposed) return
        const next: AudioStatus = this.failed ? "unavailable" : this.context?.state !== "running" ? "locked" : this.buffers ? "ready" : "loading"
        if (next !== this.status) { this.status = next; this.options.onStatus?.(next) }
    }

    private load(): Promise<void> {
        if (this.loading) return this.loading
        const ctx = this.context!
        const fetchAudio = this.options.fetchAudio ?? (async (url, signal) => {
            const response = await fetch(url, { signal })
            if (!response.ok) throw new Error("Audio could not be loaded")
            return response.arrayBuffer()
        })
        this.loading = Promise.all(["library-room.mp3", "witch-reveal.mp3"].map(async file => {
            const bytes = await fetchAudio(`${this.options.baseUrl}${file}?v=${SOUND_REVISION}`, this.abort.signal)
            if (this.disposed) throw new Error("Audio disposed")
            return ctx.decodeAudioData(bytes)
        })).then(([room, reveal]) => {
            if (this.disposed) return
            this.buffers = { room, reveal }; this.reportStatus(); this.reconcile()
        }).catch(() => {
            if (this.disposed) return
            this.failed = true; this.buffers = null; this.stopVoices(); this.reportStatus()
        })
        return this.loading
    }

    private reconcile(): void {
        const ctx = this.context
        if (this.disposed || !ctx) return
        const frame = this.frame
        if (!this.requested || ctx.state !== "running" || !this.buffers || this.failed || this.hidden || frame.muted || !frame.active) {
            this.stopVoices(); return
        }
        if (!this.room) this.room = this.startVoice(this.buffers.room, this.roomGain!, true, this.roomOffset % this.buffers.room.duration)
        const reveal = frame.reveal
        const level = atmosphereLevel(reveal?.elapsed)
        if (Math.abs(this.roomLevel - level) > .003) {
            const ramp = level < this.roomLevel ? .025 : .12
            this.roomGain!.gain.setTargetAtTime(level, ctx.currentTime, ramp); this.roomLevel = level
        }
        const pan = Math.max(-.65, Math.min(.65, frame.pan ?? 0))
        if (Math.abs(this.currentPan - pan) > .015) {
            this.panner!.pan.setTargetAtTime(pan, ctx.currentTime, .08); this.currentPan = pan
        }
        const duration = Math.min(REVEAL_SECONDS, this.buffers.reveal.duration)
        if (!reveal || reveal.token < this.highestToken || reveal.token <= 0 || !Number.isFinite(reveal.elapsed)
            || reveal.elapsed < 0 || reveal.elapsed >= duration - .025 || this.finishedToken === reveal.token) {
            this.stopReveal(); return
        }
        // The visual director is the clock. Seek after a pause, late load/unlock, newer cue or substantial drift.
        const played = this.reveal ? this.reveal.offset + ctx.currentTime - this.reveal.clock : -1
        if (!this.reveal || this.reveal.token !== reveal.token || Math.abs(played - reveal.elapsed) > .24) {
            this.stopReveal()
            const voice = this.startVoice(this.buffers.reveal, this.panner!, false, reveal.elapsed)
            voice.token = reveal.token; this.reveal = voice
            voice.source.onended = () => {
                voice.source.disconnect(); voice.gain.disconnect()
                if (this.reveal === voice) { this.reveal = null; this.finishedToken = voice.token! }
            }
        }
    }

    private startVoice(buffer: AudioBuffer, destination: AudioNode, loop: boolean, offset: number): Voice {
        const ctx = this.context!, source = ctx.createBufferSource(), gain = ctx.createGain()
        source.buffer = buffer; source.loop = loop; source.connect(gain); gain.connect(destination)
        gain.gain.setValueAtTime(0, ctx.currentTime)
        gain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE_SECONDS)
        source.start(ctx.currentTime, offset)
        return { source, gain, clock: ctx.currentTime, offset }
    }

    private stop(voice: Voice): void {
        const ctx = this.context!
        voice.source.onended = () => { voice.source.disconnect(); voice.gain.disconnect() }
        voice.gain.gain.cancelScheduledValues(ctx.currentTime)
        voice.gain.gain.setTargetAtTime(0, ctx.currentTime, .008)
        try { voice.source.stop(ctx.currentTime + FADE_SECONDS) } catch { /* Already finished. */ }
    }
    private stopReveal(): void { if (this.reveal) { this.stop(this.reveal); this.reveal = null } }
    private stopVoices(): void {
        if (this.room) {
            this.roomOffset = this.room.offset + this.context!.currentTime - this.room.clock
            this.stop(this.room); this.room = null
        }
        this.stopReveal()
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true; this.abort.abort(); this.stopVoices(); this.buffers = null
        if (this.context) {
            this.context.onstatechange = null
            this.master?.disconnect(); this.roomGain?.disconnect(); this.revealGain?.disconnect(); this.panner?.disconnect()
            void this.context.close().catch(() => {})
        }
    }
}
