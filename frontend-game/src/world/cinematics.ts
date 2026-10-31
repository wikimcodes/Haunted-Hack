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
    introduction: { candles: 1, moon: 1, fill: 1, hemisphere: 1, environment: 1, background: .65, exposure: 1.1, fog: .025, witch: 1, dawn: 0 },
    suspicion: { candles: .68, moon: .80, fill: .85, hemisphere: .75, environment: .8, background: .5, exposure: 1.02, fog: .030, witch: 1, dawn: 0 },
    won: { candles: .9, moon: 1.15, fill: 1, hemisphere: 1.3, environment: 1.25, background: .85, exposure: 1.16, fog: .018, witch: 0, dawn: 1 },
    lost: { candles: .04, moon: .28, fill: .15, hemisphere: .18, environment: .28, background: .13, exposure: .9, fog: .042, witch: 1, dawn: 0 }
}
/** Public, global story state only. No monster identity or hidden role enters these profiles. */
export function lightProfile(state: PresentationState = "introduction"): LightProfile { return { ...PROFILES[state] } }
export const REVEAL_ENTER = .9
export const REVEAL_RETURN = 4.6
export const REVEAL_DURATION = 6
export function ease(value: number): number { const t = MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t) }
export function revealEnvelope(elapsed: number): number {
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= REVEAL_DURATION) return 0
    if (elapsed < REVEAL_ENTER) return ease(elapsed / REVEAL_ENTER)
    if (elapsed < REVEAL_RETURN) return 1
    return 1 - ease((elapsed - REVEAL_RETURN) / (REVEAL_DURATION - REVEAL_RETURN))
}
/** Slow, restrained brightness modulation rather than a strobe. */
export function candleModulation(seconds: number, phase: number, revealing: number, reducedMotion: boolean): number {
    if (reducedMotion) return 1 - .16 * revealing
    const ordinary = .035 * Math.sin(seconds * 3.2 + phase) + .015 * Math.sin(seconds * 13 + phase)
    const reveal = .08 * Math.sin(seconds * 2.3 + phase)
    return MathUtils.clamp(1 + ordinary * (1 - revealing) - .16 * revealing + reveal * revealing, .7, 1.05)
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
            if (elapsed < REVEAL_ENTER) blend(this.camera, from, shot, ease(elapsed / REVEAL_ENTER))
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
