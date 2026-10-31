import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from "three"
import type { MonsterId } from "../types"

export type PresentationState = "introduction" | "suspicion" | "won" | "lost"
export interface CameraPose { position: Vector3; quaternion: Quaternion; fov: number }
export interface CameraPreset { position: [number, number, number]; target: [number, number, number]; fov: number }
export interface PresentationManifest {
    cameraPresets: { wide: CameraPreset; witch: CameraPreset }
    lights: { witch: [number, number, number]; window: [number, number, number]; exit: [number, number, number] }
}
export const DEFAULT_PRESENTATION: PresentationManifest = {
    cameraPresets: {
        wide: { position: [-0.7, 1.65, 4.35], target: [-0.3, 1.9, -4.6], fov: 58 },
        witch: { position: [-0.25, 1.65, -1.6], target: [0, 1.65, -6.65], fov: 42 }
    },
    lights: { witch: [-0.8, 2.7, -6.95], window: [0.7, 4.4, -7.3], exit: [3.55, 1.9, -3.65] }
}

export interface LightProfile {
    candles: number; moon: number; fill: number; hemisphere: number; environment: number
    background: number; exposure: number; fog: number; witch: number; dawn: number
}
const PROFILES: Record<PresentationState, LightProfile> = {
    introduction: { candles: 1, moon: 1, fill: 1, hemisphere: 1, environment: 1, background: .42, exposure: 1.04, fog: .027, witch: 1, dawn: 0 },
    suspicion: { candles: .62, moon: .72, fill: .70, hemisphere: .65, environment: .65, background: .32, exposure: .99, fog: .032, witch: 1, dawn: 0 },
    won: { candles: .9, moon: 1.15, fill: 1, hemisphere: 1.3, environment: 1.25, background: .85, exposure: 1.16, fog: .018, witch: 0, dawn: 1 },
    lost: { candles: .04, moon: .28, fill: .15, hemisphere: .18, environment: .28, background: .13, exposure: .9, fog: .042, witch: 1, dawn: 0 }
}
/** Public, global story state only. No monster identity or hidden role enters these profiles. */
export function lightProfile(state: PresentationState = "introduction"): LightProfile { return { ...PROFILES[state] } }
/** One six-second cue shared by camera, lighting and audio's director elapsed time. */
export const REVEAL_HOLD = .65
export const REVEAL_ENTER = .95
export const REVEAL_LIGHT_FULL = 1.2
export const REVEAL_RETURN = 4.6
export const REVEAL_DURATION = 6
export function ease(value: number): number { const t = MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t) }
/** Violet light arrives after the held breath and camera move, never before it. */
export function revealEnvelope(elapsed: number): number {
    if (!Number.isFinite(elapsed) || elapsed < REVEAL_ENTER || elapsed >= REVEAL_DURATION) return 0
    if (elapsed < REVEAL_LIGHT_FULL) return ease((elapsed - REVEAL_ENTER) / (REVEAL_LIGHT_FULL - REVEAL_ENTER))
    if (elapsed < REVEAL_RETURN) return 1
    return 1 - ease((elapsed - REVEAL_RETURN) / (REVEAL_DURATION - REVEAL_RETURN))
}
/** Smooth darkness, followed by a local apparition, then the original scene light. No flashing. */
export function revealLighting(elapsed: number) {
    const valid = Number.isFinite(elapsed) && elapsed >= 0 && elapsed < REVEAL_DURATION
    const darkness = !valid ? 0 : elapsed < .22 ? ease(elapsed / .22)
        : elapsed < REVEAL_RETURN ? 1 : 1 - ease((elapsed - REVEAL_RETURN) / (REVEAL_DURATION - REVEAL_RETURN))
    return sceneLighting(darkness, revealEnvelope(elapsed))
}
export type SceneLighting = ReturnType<typeof sceneLighting>
function sceneLighting(darkness: number, presence: number) {
    return {
        darkness, presence,
        candles: 1 - .93 * darkness + .15 * presence,
        fill: 1 - .90 * darkness,
        moon: 1 - .78 * darkness,
        environment: 1 - .84 * darkness,
        background: 1 - .52 * darkness
    }
}
/** A surprise glimpse: short, and unlike the reveal it never takes the camera. */
export const SCARE_DURATION = 1.8
/** The room drops out, the witch flickers in the window twice, holds, then the light returns. */
export function scareLighting(elapsed: number, reducedMotion = false) {
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= SCARE_DURATION) return sceneLighting(0, 0)
    const darkness = elapsed < .06 ? elapsed / .06 : elapsed < 1.05 ? 1 : 1 - ease((elapsed - 1.05) / (SCARE_DURATION - 1.05))
    const fade = elapsed < 1.05 ? 1 : 1 - ease((elapsed - 1.05) / (SCARE_DURATION - 1.05))
    // Reduced motion gets one steady appearance instead of the flicker.
    const flicker = reducedMotion ? elapsed >= .12 : elapsed >= .12 && !(elapsed >= .2 && elapsed < .32) && !(elapsed >= .4 && elapsed < .46)
    return sceneLighting(darkness, flicker ? fade : 0)
}
/** The darker, more present of two cues, so a glimpse and a reveal can never fight over the lights. */
export function strongerLighting(a: SceneLighting, b: SceneLighting): SceneLighting {
    return sceneLighting(Math.max(a.darkness, b.darkness), Math.max(a.presence, b.presence))
}
/** Sparse, slow practical-light variation. The reveal itself has no periodic flicker. */
export function candleModulation(seconds: number, phase: number, revealing: number, reducedMotion: boolean): number {
    if (reducedMotion) return 1
    const ordinary = .028 * Math.sin(seconds * 2.1 + phase) + .012 * Math.sin(seconds * .73 + phase)
    return 1 + ordinary * (1 - MathUtils.clamp(revealing, 0, 1))
}
/** Cinematics keep elapsed time at low FPS; only movement/physics should clamp this value. */
export function cinematicFrameDelta(now: number, previous: number): number {
    return Number.isFinite(now) && Number.isFinite(previous) ? Math.max(0, (now - previous) / 1000) : 0
}
export function capturePose(camera: PerspectiveCamera): CameraPose {
    return { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov }
}
export function applyPose(camera: PerspectiveCamera, pose: CameraPose): void {
    camera.position.copy(pose.position); camera.quaternion.copy(pose.quaternion)
    if (camera.fov !== pose.fov) { camera.fov = pose.fov; camera.updateProjectionMatrix() }
}
export function poseLookingAt(position: Vector3, target: Vector3, fov: number): CameraPose {
    const camera = new PerspectiveCamera(fov)
    camera.position.copy(position); camera.lookAt(target)
    return capturePose(camera)
}
function blend(camera: PerspectiveCamera, from: CameraPose, to: CameraPose, alpha: number) {
    camera.position.lerpVectors(from.position, to.position, alpha)
    camera.quaternion.slerpQuaternions(from.quaternion, to.quaternion, alpha)
    const fov = MathUtils.lerp(from.fov, to.fov, alpha)
    if (Math.abs(camera.fov - fov) > .0001) { camera.fov = fov; camera.updateProjectionMatrix() }
}

interface DirectorOptions {
    reducedMotion: boolean
    focus: (id: MonsterId, walkingPose: CameraPose) => CameraPose
    witch: (walkingPose: CameraPose) => CameraPose
    onRevealChange: (active: boolean) => void
}
type Transition = { from: CameraPose; to: CameraPose; elapsed: number; duration: number; release: boolean }

/** Owns only the rendered camera during a shot; the saved walking pose is never mutated. */
export class CameraDirector {
    private walkingPose: CameraPose | null = null
    private focusId: MonsterId | null = null
    private transition: Transition | null = null
    private reveal: { elapsed: number; from: CameraPose; shot: CameraPose } | null = null
    private lastToken = 0
    constructor(private camera: PerspectiveCamera, private options: DirectorOptions) {}
    get movementBlocked(): boolean { return this.walkingPose !== null }
    get isRevealing(): boolean { return this.reveal !== null }
    get revealStrength(): number { return this.reveal ? revealEnvelope(this.reveal.elapsed) : 0 }
    get elapsed(): number { return this.reveal?.elapsed ?? 0 }

    cancel(): void {
        if (this.walkingPose) applyPose(this.camera, this.walkingPose)
        const wasRevealing = this.isRevealing
        this.walkingPose = null; this.focusId = null; this.transition = null; this.reveal = null
        if (wasRevealing) this.options.onRevealChange(false)
    }

    update(delta: number, active: boolean, focus: MonsterId | null, token: number): void {
        if (!active) { if (Number.isFinite(token)) this.lastToken = Math.max(this.lastToken, token); this.cancel(); return }
        const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0
        if (Number.isFinite(token) && token > this.lastToken && token > 0) {
            this.lastToken = token
            if (!this.walkingPose) this.walkingPose = capturePose(this.camera)
            const wasRevealing = this.isRevealing
            this.reveal = { elapsed: 0, from: capturePose(this.camera), shot: this.options.witch(this.walkingPose) }
            this.transition = null
            if (!wasRevealing) this.options.onRevealChange(true)
        }
        if (this.reveal && this.walkingPose) {
            this.reveal.elapsed += dt
            const { elapsed, from, shot } = this.reveal
            const destination = focus ? this.options.focus(focus, this.walkingPose) : this.walkingPose
            if (elapsed < REVEAL_HOLD) applyPose(this.camera, from)
            else if (elapsed < REVEAL_ENTER) blend(this.camera, from, shot, ease((elapsed - REVEAL_HOLD) / (REVEAL_ENTER - REVEAL_HOLD)))
            else if (elapsed < REVEAL_RETURN) applyPose(this.camera, shot)
            else if (elapsed < REVEAL_DURATION) blend(this.camera, shot, destination, ease((elapsed - REVEAL_RETURN) / (REVEAL_DURATION - REVEAL_RETURN)))
            else {
                applyPose(this.camera, destination)
                this.reveal = null; this.focusId = focus
                if (!focus) this.walkingPose = null
                this.options.onRevealChange(false)
            }
            return
        }
        if (focus !== this.focusId) {
            if (focus) {
                if (!this.walkingPose) this.walkingPose = capturePose(this.camera)
                this.transition = { from: capturePose(this.camera), to: this.options.focus(focus, this.walkingPose), elapsed: 0, duration: this.options.reducedMotion ? .2 : .8, release: false }
            } else if (this.walkingPose) {
                this.transition = { from: capturePose(this.camera), to: this.walkingPose, elapsed: 0, duration: this.options.reducedMotion ? .2 : .65, release: true }
            }
            this.focusId = focus
        }
        if (this.transition) {
            this.transition.elapsed += dt
            const t = this.transition
            blend(this.camera, t.from, t.to, ease(t.elapsed / t.duration))
            if (t.elapsed >= t.duration) {
                applyPose(this.camera, t.to)
                if (t.release) this.walkingPose = null
                this.transition = null
            }
        }
    }
}
