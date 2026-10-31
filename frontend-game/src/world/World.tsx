import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import * as THREE from "three"
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { HDRLoader } from "three/addons/loaders/HDRLoader.js"
import type { MonsterId, Mood } from "../types"
import { LibraryAudio, type AudioStatus } from "../audio/LibraryAudio"
import { EYE_HEIGHT, isWalkable, moveWithCollisions, OBSTACLES, SPAWN } from "./collision"
import { CameraDirector, DEFAULT_PRESENTATION, candleModulation, cinematicFrameDelta, lightProfile, poseLookingAt, revealLighting, type CameraPose, type PresentationManifest, type PresentationState } from "./cinematics"
import "./world.css"

export interface WorldHandle { lock(): void; unlock(): void; reset(): void; unlockAudio(): Promise<boolean> }
export interface WorldProps {
    active: boolean
    interactive: boolean
    moods: Partial<Record<MonsterId, Mood>>
    doorOpen: boolean
    presentation?: PresentationState
    focusMonster?: MonsterId | null
    revealToken?: number
    soundMuted?: boolean
    onAudioStatus?: (status: AudioStatus) => void
    /** True only while the short witch reveal owns the camera. Keep active=true to play it. */
    onCinematicChange?: (active: boolean) => void
    onProgress: (percent: number) => void
    onReady: () => void
    onError: (message: string) => void
    onLockChange: (locked: boolean) => void
    onTargetChange: (id: MonsterId | null) => void
    onInteract: (id: MonsterId) => void
}

type Placement = { position: [number, number, number]; scale: [number, number, number]; quaternion?: [number, number, number, number]; rotationY?: number }
type Manifest = { camera: { target: [number, number, number] }; assets: Record<string, { file: string; bytes: number; placement: Placement }> }
type LightManifest = { lights: { name: string; type: string; position: [number, number, number]; blenderPowerWatts: number }[] }
type Spirit = { root: THREE.Group; mixer: THREE.AnimationMixer; actions: Record<string, THREE.AnimationAction>; current: string }
type Runtime = WorldHandle & { clearKeys(): void; syncAudio(): void }

const IDS: MonsterId[] = ["sprout", "pebble", "momo"]
const BASE = `${import.meta.env.BASE_URL}assets/library/`
const ANIMATIONS: Record<Mood, string> = { idle: "Idle", talking: "Talk", thinking: "Think", nervous: "Think", accused: "Accused" }
const textureProperties = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap", "transmissionMap"] as const

function disposeObject(root: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    root.traverse(object => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return
        geometries.add(object.geometry)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(material)
            const pbr = material as THREE.MeshStandardMaterial
            for (const key of textureProperties) {
                const texture = (pbr as unknown as Record<string, unknown>)[key]
                if (texture instanceof THREE.Texture) textures.add(texture)
            }
        }
    })
    geometries.forEach(item => item.dispose())
    materials.forEach(item => item.dispose())
    textures.forEach(item => {
        if (typeof ImageBitmap !== "undefined" && item.image instanceof ImageBitmap) item.image.close()
        item.dispose()
    })
}

async function readJson<T>(file: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(BASE + file, { signal })
    if (!response.ok) throw new Error(`Could not load ${file} (${response.status}).`)
    return response.json() as Promise<T>
}

/** Real GLB scene. Game authority and interface remain in the parent React application. */
export const World = forwardRef<WorldHandle, WorldProps>(function World(props, ref) {
    const hostRef = useRef<HTMLDivElement>(null)
    const latest = useRef(props)
    latest.current = props
    const runtime = useRef<Runtime | null>(null)
    const keys = useRef(new Set<string>())
    const [dragFallback, setDragFallback] = useState(false)
    const [coarse, setCoarse] = useState(false)
    const [cinematicActive, setCinematicActive] = useState(false)

    useImperativeHandle(ref, () => ({
        lock: () => runtime.current?.lock(),
        unlock: () => runtime.current?.unlock(),
        reset: () => runtime.current?.reset(),
        unlockAudio: () => runtime.current?.unlockAudio() ?? Promise.resolve(false)
    }), [])

    useEffect(() => {
        if (!props.active || !props.interactive) {
            runtime.current?.clearKeys()
            runtime.current?.unlock()
        }
        runtime.current?.syncAudio()
    }, [props.active, props.interactive, props.soundMuted])

    useEffect(() => {
        const host = hostRef.current
        if (!host) return
        const isCoarse = matchMedia("(pointer: coarse)").matches
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
        setCoarse(isCoarse)
        let disposed = false
        let failed = false
        let ready = false
        let needsRender = true
        let animationFrame = 0
        let lastTime = performance.now()
        let lastTargetCheck = 0
        let hovered: MonsterId | null = null
        let dragging = false
        let dragDistance = 0
        let pointerX = 0
        let pointerY = 0
        let lastDoorOpen = false
        let presentationConfig = DEFAULT_PRESENTATION
        let director: CameraDirector | null = null
        const abort = new AbortController()
        const scene = new THREE.Scene()
        scene.background = new THREE.Color("#111d22")
        scene.fog = new THREE.FogExp2("#111d25", 0.027)
        const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 85)
        camera.position.set(SPAWN.x, EYE_HEIGHT, SPAWN.z)
        const aim = new THREE.Vector3(-1.9, 2.39, -5.2)
        camera.lookAt(aim)
        const orientation = new THREE.Euler(0, 0, 0, "YXZ")
        orientation.setFromQuaternion(camera.quaternion, "YXZ")
        let renderer: THREE.WebGLRenderer
        try {
            renderer = new THREE.WebGLRenderer({ antialias: !isCoarse, alpha: false, powerPreference: "high-performance" })
        } catch {
            latest.current.onError("This browser could not start WebGL. Try a browser with hardware acceleration enabled.")
            return
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, isCoarse ? 1.25 : 1.6))
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.AgXToneMapping
        renderer.toneMappingExposure = 1.04
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFShadowMap
        const canvas = renderer.domElement
        canvas.tabIndex = 0
        canvas.setAttribute("aria-label", "Haunted library. Drag to look, use W A S D to walk, and E to speak to a nearby ghost.")
        canvas.dataset.testid = "library-canvas"
        host.appendChild(canvas)
        const audio = new LibraryAudio({ baseUrl: `${import.meta.env.BASE_URL}audio/`, onStatus: status => { if (!disposed) latest.current.onAudioStatus?.(status) } })
        latest.current.onAudioStatus?.("locked")
        audio.setHidden(document.hidden)
        const audioForward = new THREE.Vector3(), audioRight = new THREE.Vector3(), audioWindow = new THREE.Vector3()

        const spirits = new Map<MonsterId, Spirit>()
        let door: Spirit | null = null
        let witch: Spirit | null = null
        const witchMaterials: { material: THREE.MeshStandardMaterial; opacity: number; emission: number; eyes: boolean }[] = []
        const candleMaterials = new Map<THREE.MeshStandardMaterial, number>()
        const spiritMaterials = new Map<THREE.MeshPhysicalMaterial, { color: THREE.Color; sheen: THREE.Color | null }>()
        const windowMaterials = new Map<THREE.MeshStandardMaterial, { emission: THREE.Color; intensity: number }>()
        const windowViolet = new THREE.Color("#734ba9")
        let hdri: THREE.DataTexture | null = null
        let environment: THREE.WebGLRenderTarget | null = null
        const pmrem = new THREE.PMREMGenerator(renderer)
        pmrem.compileEquirectangularShader()
        const raycaster = new THREE.Raycaster()
        const pointer = new THREE.Vector2()
        const hitPoint = new THREE.Vector3()
        const blockers = OBSTACLES.map(box => new THREE.Box3(
            new THREE.Vector3(box.minX, 0, box.minZ), new THREE.Vector3(box.maxX, box.height, box.maxZ)
        ))
        const movingDirection = new THREE.Vector3()
        const flickerLights: { light: THREE.PointLight; base: number; phase: number }[] = []

        const hemisphere = new THREE.HemisphereLight("#8ebac9", "#38291b", 0.11)
        scene.add(hemisphere)
        const moon = new THREE.DirectionalLight("#addfea", 2.1)
        moon.position.set(1.2, 6, -7.2)
        moon.target.position.set(-1.3, 0.5, 2)
        moon.castShadow = true
        moon.shadow.mapSize.set(isCoarse ? 1024 : 2048, isCoarse ? 1024 : 2048)
        moon.shadow.camera.left = -7
        moon.shadow.camera.right = 7
        moon.shadow.camera.top = 8
        moon.shadow.camera.bottom = -8
        moon.shadow.camera.near = 0.3
        moon.shadow.camera.far = 24
        moon.shadow.normalBias = 0.035
        moon.shadow.bias = -0.00015
        scene.add(moon, moon.target)
        const ghostFill = new THREE.PointLight("#a5d8e0", 4.2, 8, 2)
        ghostFill.position.set(-0.1, 3.8, -1.1)
        scene.add(ghostFill)
        const windowPulse = new THREE.SpotLight("#987bc2", 0, 6, .52, .75, 2)
        windowPulse.position.fromArray(presentationConfig.lights.window)
        const witchRim = new THREE.SpotLight("#b995e1", .08, 4, .68, .75, 2)
        witchRim.position.fromArray(presentationConfig.lights.witch)
        // A narrow side light catches the charcoal cloth, without washing the foreground ghosts.
        const witchContour = new THREE.SpotLight("#b7a4d8", 0, 5, .48, .65, 2)
        witchContour.target.position.fromArray(presentationConfig.cameraPresets.witch.target)
        witchContour.position.copy(witchContour.target.position).add(new THREE.Vector3(-1.25, 1.25, 1.55))
        const dawn = new THREE.PointLight("#ffce8a", 0, 11, 2)
        dawn.position.fromArray(presentationConfig.lights.exit)
        windowPulse.target.position.fromArray(presentationConfig.cameraPresets.witch.target)
        witchRim.target.position.copy(windowPulse.target.position)
        scene.add(windowPulse, windowPulse.target, witchRim, witchRim.target, witchContour, witchContour.target, dawn)
        const currentLight = lightProfile()
        const moonColor = new THREE.Color("#addfea")
        const revealColor = new THREE.Color("#b6a1d9")
        const goldColor = new THREE.Color("#f1d2a1")

        function routeIsClear(from: THREE.Vector3, to: THREE.Vector3): boolean {
            const distance = from.distanceTo(to)
            const steps = Math.max(1, Math.ceil(distance / .12))
            for (let i = 0; i <= steps; i++) {
                const t = i / steps
                if (!isWalkable({ x: THREE.MathUtils.lerp(from.x, to.x, t), z: THREE.MathUtils.lerp(from.z, to.z, t) }, latest.current.doorOpen)) return false
            }
            // Character cloth is not a walking obstacle, but a shot must not fly through it.
            const direction = to.clone().sub(from).normalize()
            const ray = new THREE.Ray(from, direction)
            for (const spirit of spirits.values()) {
                spirit.root.updateMatrixWorld(true)
                const cloth = new THREE.Box3().setFromObject(spirit.root).expandByScalar(.18)
                if (cloth.containsPoint(from) || cloth.containsPoint(to)) return false
                const hit = ray.intersectBox(cloth, new THREE.Vector3())
                if (hit && from.distanceTo(hit) < distance) return false
            }
            return true
        }
        function focusPose(id: MonsterId, walking: CameraPose): CameraPose {
            const spirit = spirits.get(id)
            if (!spirit) return walking
            spirit.root.updateMatrixWorld(true)
            const box = new THREE.Box3().setFromObject(spirit.root)
            const target = box.getCenter(new THREE.Vector3())
            target.y = THREE.MathUtils.lerp(box.min.y, box.max.y, .77)
            const toward = target.clone().sub(walking.position); toward.y = 0
            const distance = toward.length()
            const proposed = walking.position.clone()
            if (!reducedMotion && distance > 1.35) {
                const step = toward.normalize().multiplyScalar(Math.min(.65, distance - 1.35))
                const safe = moveWithCollisions(walking.position, { x: step.x, z: step.z }, latest.current.doorOpen)
                proposed.set(safe.x, EYE_HEIGHT, safe.z)
            }
            return reducedMotion ? walking : poseLookingAt(proposed, target, 45)
        }
        function witchPose(walking: CameraPose): CameraPose {
            if (reducedMotion) return walking
            const preset = presentationConfig.cameraPresets.witch
            // Stay in front of the ghosts. Height clears Sprout; the left offset clears Pebble.
            // Moving closer instead would put the camera inside their animated cloth.
            const position = new THREE.Vector3().fromArray(preset.position).add(new THREE.Vector3(-.6, .9, -.3))
            const target = new THREE.Vector3().fromArray(preset.target)
            // From a side/rear aisle, hold position if furniture or a ghost obstructs the route.
            if (!routeIsClear(walking.position, position)) position.copy(walking.position)
            const fitFov = THREE.MathUtils.radToDeg(2 * Math.atan(1.65 / Math.max(1, position.distanceTo(target))))
            return poseLookingAt(position, target, THREE.MathUtils.clamp(Math.max(preset.fov, fitFov), 38, 68))
        }
        director = new CameraDirector(camera, {
            reducedMotion, focus: focusPose, witch: witchPose,
            onRevealChange: active => {
                clearKeys(); updateTarget(null)
                if (active) unlock()
                if (!disposed) {
                    setCinematicActive(active); latest.current.onCinematicChange?.(active)
                    // Start audio after update has advanced this frame; cancel must silence immediately.
                    if (!active) syncAudio()
                }
            }
        })

        function clearKeys() { keys.current.clear(); dragging = false }
        function unlock() {
            clearKeys()
            if (document.pointerLockElement === canvas) document.exitPointerLock()
        }
        function fallback() {
            if (disposed) return
            setDragFallback(true)
            latest.current.onLockChange(false)
        }
        function lock() {
            if (!ready || !latest.current.active || !latest.current.interactive || director?.movementBlocked) return
            canvas.focus({ preventScroll: true })
            if (isCoarse || !canvas.requestPointerLock) { fallback(); return }
            try {
                const request = canvas.requestPointerLock()
                if (request && "catch" in request) request.catch(fallback)
            } catch { fallback() }
        }
        function reset() {
            director?.cancel()
            clearKeys()
            camera.position.fromArray(presentationConfig.cameraPresets.wide.position)
            camera.lookAt(aim)
            camera.fov = presentationConfig.cameraPresets.wide.fov
            camera.updateProjectionMatrix()
            orientation.setFromQuaternion(camera.quaternion, "YXZ")
            needsRender = true
            syncAudio()
        }
        function syncAudio() {
            camera.getWorldDirection(audioForward)
            audioRight.crossVectors(audioForward, camera.up).normalize()
            audioWindow.fromArray(presentationConfig.cameraPresets.witch.target).sub(camera.position).normalize()
            audio.update({
                active: latest.current.active && ready && !failed, muted: latest.current.soundMuted ?? false,
                reveal: director?.isRevealing ? { token: latest.current.revealToken ?? 0, elapsed: director.elapsed, strength: director.revealStrength } : null,
                pan: audioRight.dot(audioWindow) * .65
            })
        }
        runtime.current = { lock, unlock, reset, clearKeys, syncAudio, unlockAudio: () => audio.unlock() }

        function updateTarget(id: MonsterId | null) {
            if (hovered === id) return
            hovered = id
            latest.current.onTargetChange(id)
        }
        function selectAt(x: number, y: number): MonsterId | null {
            if (!ready || !latest.current.active || !latest.current.interactive || director?.movementBlocked) return null
            pointer.set(x, y)
            raycaster.setFromCamera(pointer, camera)
            raycaster.far = 3.5
            const roots = [...spirits.values()].map(spirit => spirit.root)
            const hit = raycaster.intersectObjects(roots, true).find(item => {
                let node: THREE.Object3D | null = item.object
                while (node && !node.userData.monsterId) node = node.parent
                return node !== null
            })
            if (!hit) return null
            // Furniture and bookcase proxies prevent selecting a ghost through solid obstacles.
            for (const box of blockers) {
                if (box.containsPoint(camera.position)) continue
                const point = raycaster.ray.intersectBox(box, hitPoint)
                if (point && camera.position.distanceTo(point) < hit.distance - 0.03) return null
            }
            let owner: THREE.Object3D | null = hit.object
            while (owner && !owner.userData.monsterId) owner = owner.parent
            return (owner?.userData.monsterId as MonsterId | undefined) ?? null
        }
        function interact(id: MonsterId | null) {
            if (!id) return
            unlock()
            latest.current.onInteract(id)
        }
        function look(dx: number, dy: number) {
            orientation.y -= dx * 0.0021
            orientation.x = THREE.MathUtils.clamp(orientation.x - dy * 0.0021, -1.35, 1.35)
            orientation.z = 0
            camera.quaternion.setFromEuler(orientation)
            needsRender = true
        }
        function onMouseMove(event: MouseEvent) {
            if (document.pointerLockElement === canvas && latest.current.interactive && !director?.movementBlocked) look(event.movementX, event.movementY)
        }
        function onPointerDown(event: PointerEvent) {
            if (!latest.current.active || !latest.current.interactive || director?.movementBlocked) return
            canvas.focus({ preventScroll: true })
            if (document.pointerLockElement === canvas) return
            dragging = true; dragDistance = 0; pointerX = event.clientX; pointerY = event.clientY
            canvas.setPointerCapture(event.pointerId)
        }
        function onPointerMove(event: PointerEvent) {
            if (!dragging || document.pointerLockElement === canvas || !latest.current.interactive || director?.movementBlocked) return
            const dx = event.clientX - pointerX, dy = event.clientY - pointerY
            dragDistance += Math.abs(dx) + Math.abs(dy)
            look(dx, dy)
            pointerX = event.clientX; pointerY = event.clientY
        }
        function onPointerUp(event: PointerEvent) {
            if (!latest.current.interactive || director?.movementBlocked) return
            if (document.pointerLockElement === canvas) {
                interact(selectAt(0, 0))
            } else if (dragging && dragDistance < 6) {
                const bounds = canvas.getBoundingClientRect()
                interact(selectAt((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1))
            }
            dragging = false
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        }
        function editable(event: KeyboardEvent) {
            const target = event.target
            return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
        }
        function onKeyDown(event: KeyboardEvent) {
            if (!latest.current.active || editable(event)) return
            if (director?.movementBlocked) {
                if (event.code === "Escape" && director.isRevealing) { director.cancel(); orientation.setFromQuaternion(camera.quaternion, "YXZ"); needsRender = true }
                return
            }
            if (!latest.current.interactive) return
            if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(event.code)) {
                event.preventDefault(); keys.current.add(event.code)
            }
            if (event.code === "KeyE" && !event.repeat) { event.preventDefault(); interact(selectAt(0, 0)) }
            if (event.code === "Escape") unlock()
        }
        function onKeyUp(event: KeyboardEvent) { keys.current.delete(event.code) }
        function onLockChange() {
            const locked = document.pointerLockElement === canvas
            clearKeys()
            if (!disposed) {
                if (locked) setDragFallback(false)
                latest.current.onLockChange(locked)
            }
        }
        function onVisibility() {
            if (document.hidden) clearKeys()
            lastTime = performance.now()
            audio.setHidden(document.hidden)
            syncAudio()
        }
        function onContextLost(event: Event) {
            event.preventDefault()
            failed = true
            syncAudio()
            unlock()
            latest.current.onError("The graphics connection was interrupted. Reload the scene to continue.")
        }
        canvas.addEventListener("pointerdown", onPointerDown)
        canvas.addEventListener("pointermove", onPointerMove)
        canvas.addEventListener("pointerup", onPointerUp)
        canvas.addEventListener("pointercancel", clearKeys)
        canvas.addEventListener("webglcontextlost", onContextLost)
        document.addEventListener("mousemove", onMouseMove)
        document.addEventListener("pointerlockchange", onLockChange)
        document.addEventListener("pointerlockerror", fallback)
        window.addEventListener("keydown", onKeyDown)
        window.addEventListener("keyup", onKeyUp)
        window.addEventListener("blur", clearKeys)
        document.addEventListener("visibilitychange", onVisibility)

        function resize() {
            const { width, height } = host!.getBoundingClientRect()
            if (!width || !height) return
            camera.aspect = width / height
            camera.updateProjectionMatrix()
            renderer.setSize(width, height, false)
            needsRender = true
        }
        const observer = new ResizeObserver(resize)
        observer.observe(host)
        resize()

        function applyPlacement(root: THREE.Group, placement: Placement) {
            root.position.fromArray(placement.position)
            root.scale.fromArray(placement.scale)
            if (placement.quaternion) root.quaternion.fromArray(placement.quaternion)
            else root.rotation.y = placement.rotationY ?? 0
        }
        function prepare(root: THREE.Group, character = false) {
            root.traverse(object => {
                if (!(object instanceof THREE.Mesh)) return
                object.castShadow = !character
                object.receiveShadow = true
                const materials = Array.isArray(object.material) ? object.material : [object.material]
                for (const material of materials) {
                    const pbr = material as THREE.MeshStandardMaterial
                    if (character && pbr.transparent) pbr.depthWrite = false
                    if (/flame|hot.core|ember|candle fire/i.test(pbr.name) && pbr.emissiveIntensity > 0) candleMaterials.set(pbr, pbr.emissiveIntensity)
                    if (/window glass/i.test(pbr.name) && !windowMaterials.has(pbr)) {
                        windowMaterials.set(pbr, { emission: pbr.emissive.clone(), intensity: pbr.emissiveIntensity })
                        // World-space mist crosses pane boundaries; glass never becomes a tiled glowing panel.
                        // Its normal emission is black, so this leaves the original unlit glass unchanged.
                        pbr.onBeforeCompile = shader => {
                            shader.vertexShader = shader.vertexShader
                                .replace("#include <common>", "#include <common>\nvarying vec3 vWindowWorld;")
                                .replace("#include <project_vertex>", "#include <project_vertex>\nvWindowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;")
                            shader.fragmentShader = shader.fragmentShader
                                .replace("#include <common>", "#include <common>\nvarying vec3 vWindowWorld;")
                                .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
                                    vec2 mistPosition = vWindowWorld.xy;
                                    vec2 haloOffset = (mistPosition - vec2(-0.1, 2.8)) * vec2(0.60, 0.29);
                                    float halo = exp(-dot(haloOffset, haloOffset));
                                    float mist = 0.68
                                        + 0.16 * sin(mistPosition.x * 2.1 + mistPosition.y * 1.3)
                                        + 0.11 * sin(mistPosition.x * 1.4 - mistPosition.y * 2.0)
                                        + 0.07 * sin(mistPosition.x * 3.7 + mistPosition.y * 0.8);
                                    totalEmissiveRadiance *= (0.22 + 0.78 * halo) * clamp(mist, 0.30, 1.0);
                                `)
                        }
                        pbr.customProgramCacheKey = () => "library-window-mist-v1"
                        pbr.needsUpdate = true
                    }
                    for (const key of textureProperties) {
                        const texture = (pbr as unknown as Record<string, unknown>)[key]
                        if (texture instanceof THREE.Texture) texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4)
                    }
                }
            })
        }
        function animated(gltf: GLTF): Spirit {
            const mixer = new THREE.AnimationMixer(gltf.scene)
            const actions: Record<string, THREE.AnimationAction> = {}
            gltf.animations.forEach(clip => { actions[clip.name] = mixer.clipAction(clip) })
            return { root: gltf.scene, mixer, actions, current: "" }
        }
        function play(spirit: Spirit, name: string) {
            if (spirit.current === name) return
            const next = spirit.actions[name] ?? spirit.actions.Idle
            if (!next) return
            const previous = spirit.actions[spirit.current]
            next.reset()
            next.setLoop(name === "Accused" || name === "Open" ? THREE.LoopOnce : THREE.LoopRepeat, Infinity)
            next.clampWhenFinished = name === "Accused" || name === "Open"
            next.enabled = true
            next.setEffectiveWeight(1)
            next.fadeIn(0.22).play()
            if (previous && previous !== next) previous.fadeOut(0.22)
            spirit.current = name
        }
        async function load() {
            latest.current.onProgress(0)
            const [manifest, lighting] = await Promise.all([
                readJson<Manifest>("asset-manifest.json", abort.signal), readJson<LightManifest>("lighting-manifest.json", abort.signal)
            ])
            if (disposed) return
            try {
                const config = await readJson<PresentationManifest>("presentation-manifest.json", abort.signal)
                const presets = [config.cameraPresets?.wide, config.cameraPresets?.witch]
                const validVector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
                if (presets.every(p => p && validVector(p.position) && validVector(p.target) && p.fov >= 25 && p.fov <= 90)
                    && [config.lights?.witch, config.lights?.window, config.lights?.exit].every(validVector)) presentationConfig = config
            } catch (error) {
                if (abort.signal.aborted) throw error
                // Older asset bundles can still use the measured library camera and light anchors.
            }
            aim.fromArray(presentationConfig.cameraPresets.wide.target)
            windowPulse.position.fromArray(presentationConfig.lights.window)
            witchRim.position.fromArray(presentationConfig.lights.witch)
            windowPulse.target.position.fromArray(presentationConfig.cameraPresets.witch.target)
            witchRim.target.position.copy(windowPulse.target.position)
            witchContour.target.position.fromArray(presentationConfig.cameraPresets.witch.target)
            witchContour.position.copy(witchContour.target.position).add(new THREE.Vector3(-1.25, 1.25, 1.55))
            dawn.position.fromArray(presentationConfig.lights.exit)
            reset()
            // Four localized practicals preserve warm/cool separation without eleven per-pixel lights.
            const practicalNames = ["shelf candle 1", "shelf candle 4", "lantern candle", "right foreground candle"]
            lighting.lights.filter(light => practicalNames.some(name => light.name.endsWith(name))).forEach((source, index) => {
                const intensity = source.blenderPowerWatts * 0.45
                const light = new THREE.PointLight("#ffbb73", intensity, 5.5, 2)
                light.position.fromArray(source.position)
                scene.add(light)
                flickerLights.push({ light, base: intensity, phase: index * 2.31 })
            })
            const entries = ["environment", ...IDS, "door", ...(manifest.assets.witch ? ["witch"] : [])]
            const weights = Object.fromEntries(entries.map(id => [id, manifest.assets[id].bytes]))
            weights.hdri = 8_000_000
            const progress: Record<string, number> = {}
            const total = Object.values(weights).reduce((a, b) => a + b, 0)
            function report(id: string, fraction: number) {
                progress[id] = Math.max(progress[id] ?? 0, Math.min(1, fraction))
                if (!disposed) latest.current.onProgress(Math.min(99, Math.round(3 + Object.entries(progress).reduce((sum, [key, value]) => sum + weights[key] * value, 0) / total * 96)))
            }
            const loader = new GLTFLoader()
            loader.setMeshoptDecoder(MeshoptDecoder)
            const models = entries.map(async id => {
                const asset = manifest.assets[id]
                const gltf = await loader.loadAsync(BASE + asset.file, event => report(id, event.loaded / (event.total || asset.bytes)))
                if (disposed || failed) { disposeObject(gltf.scene); return }
                applyPlacement(gltf.scene, asset.placement)
                prepare(gltf.scene, IDS.includes(id as MonsterId) || id === "witch")
                scene.add(gltf.scene)
                if (IDS.includes(id as MonsterId)) {
                    gltf.scene.userData.monsterId = id
                    gltf.scene.traverse(object => {
                        if (!(object instanceof THREE.Mesh)) return
                        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
                            const pbr = material as THREE.MeshPhysicalMaterial
                            if (!spiritMaterials.has(pbr)) spiritMaterials.set(pbr, { color: pbr.color.clone(), sheen: pbr.sheenColor?.clone() ?? null })
                        }
                    })
                    const spirit = animated(gltf)
                    spirits.set(id as MonsterId, spirit)
                    play(spirit, "Idle")
                    spirit.mixer.update(0.4 + IDS.indexOf(id as MonsterId) * 0.37)
                } else if (id === "door") door = animated(gltf)
                else if (id === "witch") {
                    witch = animated(gltf)
                    play(witch, "Idle")
                    const seen = new Set<THREE.Material>()
                    gltf.scene.traverse(object => {
                        if (!(object instanceof THREE.Mesh)) return
                        object.renderOrder = 0
                        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
                            if (seen.has(material)) continue
                            seen.add(material)
                            const pbr = material as THREE.MeshStandardMaterial
                            witchMaterials.push({ material: pbr, opacity: pbr.opacity, emission: pbr.emissiveIntensity, eyes: /eye/i.test(object.name + pbr.name) })
                            // Nested hood, face and cloak surfaces need real depth occlusion.
                            // Normal presence is fully opaque, revealed by the light alone.
                            // Alpha hash only contributes coverage during the won fade;
                            // it leaves every pixel intact at opacity 1, with no mode pop.
                            pbr.transparent = false
                            pbr.alphaHash = true
                            pbr.depthTest = true
                            pbr.depthWrite = true
                            pbr.opacity *= currentLight.witch
                            pbr.needsUpdate = true
                            // Retain the exported charcoal textile and restrained violet emission.
                        }
                    })
                }
                report(id, 1)
            })
            const sky = new HDRLoader().loadAsync(BASE + "forest.hdr", event => report("hdri", event.loaded / (event.total || weights.hdri))).then(texture => {
                if (disposed || failed) { texture.dispose(); return }
                hdri = texture
                texture.mapping = THREE.EquirectangularReflectionMapping
                environment = pmrem.fromEquirectangular(texture)
                scene.environment = environment.texture
                scene.environmentIntensity = 0.085
                scene.environmentRotation.y = THREE.MathUtils.degToRad(25)
                scene.background = texture
                scene.backgroundIntensity = 0.42
                scene.backgroundBlurriness = 0.15
                scene.backgroundRotation.y = THREE.MathUtils.degToRad(25)
                report("hdri", 1)
            })
            await Promise.all([...models, sky])
            if (disposed || failed) return
            latest.current.onProgress(99)
            await renderer.compileAsync(scene, camera)
            if (disposed || failed) return
            ready = true
            needsRender = true
            latest.current.onProgress(100)
            latest.current.onReady()
        }
        void load().catch(error => {
            if (disposed || error?.name === "AbortError") return
            failed = true
            latest.current.onError(error instanceof Error ? error.message : "The library assets could not be loaded.")
        })

        function frame(time: number) {
            if (disposed) return
            animationFrame = requestAnimationFrame(frame)
            const elapsed = cinematicFrameDelta(time, lastTime)
            const delta = Math.min(elapsed, 0.05) // Collision and cloth simulation stay bounded.
            lastTime = time
            if (failed || document.hidden) return
            const state = latest.current
            if (ready && director) {
                const wasOwned = director.movementBlocked
                director.update(elapsed, state.active, state.focusMonster ?? null, state.revealToken ?? 0)
                if (!wasOwned && director.movementBlocked) unlock()
                if (wasOwned || director.movementBlocked) needsRender = true
                if (!director.movementBlocked) orientation.setFromQuaternion(camera.quaternion, "YXZ")
            }
            syncAudio()
            if (state.active && ready) {
                if (state.interactive && !director?.movementBlocked) {
                    const pressed = keys.current
                    const forward = Number(pressed.has("KeyW") || pressed.has("ArrowUp")) - Number(pressed.has("KeyS") || pressed.has("ArrowDown"))
                    const right = Number(pressed.has("KeyD") || pressed.has("ArrowRight")) - Number(pressed.has("KeyA") || pressed.has("ArrowLeft"))
                    if (forward || right) {
                        camera.getWorldDirection(movingDirection)
                        movingDirection.y = 0; movingDirection.normalize()
                        const speed = (pressed.has("ShiftLeft") || pressed.has("ShiftRight") ? 3.1 : 1.75) * delta / Math.hypot(forward, right)
                        const next = moveWithCollisions(camera.position, {
                            x: (movingDirection.x * forward - movingDirection.z * right) * speed,
                            z: (movingDirection.z * forward + movingDirection.x * right) * speed
                        }, state.doorOpen)
                        camera.position.set(next.x, EYE_HEIGHT, next.z)
                    }
                    if (time - lastTargetCheck > 100) { updateTarget(selectAt(0, 0)); lastTargetCheck = time }
                } else updateTarget(null)
                for (const [id, spirit] of spirits) {
                    play(spirit, ANIMATIONS[state.moods[id] ?? "idle"])
                    spirit.mixer.update(delta)
                }
                witch?.mixer.update(delta)
                if (door) {
                    if (state.doorOpen && !lastDoorOpen) {
                        door.root.traverse(object => { if (/Lock_Assembly/.test(object.name)) object.visible = false })
                        play(door, "Open")
                    } else if (!state.doorOpen && lastDoorOpen) {
                        door.mixer.stopAllAction(); door.current = ""
                        door.root.traverse(object => { if (/Lock_Assembly/.test(object.name)) object.visible = true })
                    }
                    door.mixer.update(delta)
                    lastDoorOpen = state.doorOpen
                }
                const profile = lightProfile(state.presentation ?? "introduction")
                const smoothing = 1 - Math.exp(-delta * 1.35)
                for (const key of Object.keys(currentLight) as (keyof typeof currentLight)[]) currentLight[key] = THREE.MathUtils.lerp(currentLight[key], profile[key], smoothing)
                const cue = revealLighting(director?.isRevealing ? director.elapsed : -1)
                const reveal = cue.presence
                // Keep idle cloth solid; only the public won state fades its coverage.
                const apparition = state.presentation === "won" ? currentLight.witch : 1
                flickerLights.forEach(({ light, base, phase }) => {
                    light.intensity = base * currentLight.candles * cue.candles * candleModulation(time / 1000, phase, cue.darkness, reducedMotion)
                })
                candleMaterials.forEach((base, material) => { material.emissiveIntensity = base * currentLight.candles * cue.candles * candleModulation(time / 1000, 0, cue.darkness, reducedMotion) })
                hemisphere.intensity = .11 * currentLight.hemisphere * cue.fill
                moon.intensity = 2.1 * currentLight.moon * cue.moon
                moon.color.copy(moonColor).lerp(revealColor, reveal * .18).lerp(goldColor, currentLight.dawn * .45)
                ghostFill.intensity = 4.2 * currentLight.fill * cue.fill
                windowPulse.intensity = 29 * reveal
                witchRim.intensity = .08 + 16 * reveal + (state.presentation === "lost" ? .9 : 0)
                witchContour.intensity = 26 * reveal
                // Every ghost recedes equally: this is a story cue, never a hint about the spy.
                spiritMaterials.forEach((original, material) => {
                    material.color.copy(original.color).multiplyScalar(1 - .78 * cue.darkness)
                    if (original.sheen) material.sheenColor.copy(original.sheen).multiplyScalar(1 - .88 * cue.darkness)
                })
                windowMaterials.forEach((original, material) => {
                    material.emissive.copy(original.emission).lerp(windowViolet, reveal)
                    material.emissiveIntensity = THREE.MathUtils.lerp(original.intensity, 1.1, reveal)
                })
                dawn.intensity = 85 * currentLight.dawn
                scene.environmentIntensity = .085 * currentLight.environment * cue.environment
                scene.backgroundIntensity = currentLight.background * cue.background
                renderer.toneMappingExposure = currentLight.exposure
                if (scene.fog instanceof THREE.FogExp2) scene.fog.density = currentLight.fog + .006 * reveal
                witchMaterials.forEach(({ material, opacity, emission, eyes }) => {
                    material.opacity = opacity * apparition
                    if (eyes) material.emissiveIntensity = emission * (.35 + .45 * reveal) * apparition
                })
                needsRender = true
            }
            if (needsRender) { renderer.render(scene, camera); needsRender = false }
        }
        animationFrame = requestAnimationFrame(frame)

        return () => {
            disposed = true
            audio.dispose()
            abort.abort()
            director?.cancel()
            unlock()
            runtime.current = null
            cancelAnimationFrame(animationFrame)
            observer.disconnect()
            canvas.removeEventListener("pointerdown", onPointerDown)
            canvas.removeEventListener("pointermove", onPointerMove)
            canvas.removeEventListener("pointerup", onPointerUp)
            canvas.removeEventListener("pointercancel", clearKeys)
            canvas.removeEventListener("webglcontextlost", onContextLost)
            document.removeEventListener("mousemove", onMouseMove)
            document.removeEventListener("pointerlockchange", onLockChange)
            document.removeEventListener("pointerlockerror", fallback)
            window.removeEventListener("keydown", onKeyDown)
            window.removeEventListener("keyup", onKeyUp)
            window.removeEventListener("blur", clearKeys)
            document.removeEventListener("visibilitychange", onVisibility)
            spirits.forEach(spirit => { spirit.mixer.stopAllAction(); spirit.mixer.uncacheRoot(spirit.root) })
            if (door) { door.mixer.stopAllAction(); door.mixer.uncacheRoot(door.root) }
            if (witch) { witch.mixer.stopAllAction(); witch.mixer.uncacheRoot(witch.root) }
            disposeObject(scene)
            environment?.dispose()
            hdri?.dispose()
            moon.shadow.dispose()
            pmrem.dispose()
            renderer.dispose()
            canvas.remove()
        }
    }, [])

    return <div className="world" ref={hostRef}>
        {dragFallback && !coarse && props.active && props.interactive && !cinematicActive && <div className="world-drag-hint">Drag to look · WASD to walk</div>}
        {coarse && props.active && props.interactive && !cinematicActive && <div className="world-touch-controls" aria-label="Walking controls">
            {([["KeyW", "↑", "Walk forward"], ["KeyA", "←", "Walk left"], ["KeyS", "↓", "Walk backward"], ["KeyD", "→", "Walk right"]] as const).map(([code, symbol, label]) => <button
                key={code} className={`world-touch-${code}`} aria-label={label}
                onPointerDown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); keys.current.add(code) }}
                onPointerUp={event => { event.preventDefault(); keys.current.delete(code) }}
                onPointerCancel={() => keys.current.delete(code)}
                onLostPointerCapture={() => keys.current.delete(code)}
            >{symbol}</button>)}
        </div>}
    </div>
})
