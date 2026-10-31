import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import * as THREE from "three"
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { HDRLoader } from "three/addons/loaders/HDRLoader.js"
import type { MonsterId, Mood } from "../types"
import { EYE_HEIGHT, moveWithCollisions, OBSTACLES, SPAWN } from "./collision"
import "./world.css"

export interface WorldHandle { lock(): void; unlock(): void; reset(): void }
export interface WorldProps {
    active: boolean
    interactive: boolean
    moods: Partial<Record<MonsterId, Mood>>
    doorOpen: boolean
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
type Runtime = WorldHandle & { clearKeys(): void }

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

    useImperativeHandle(ref, () => ({
        lock: () => runtime.current?.lock(),
        unlock: () => runtime.current?.unlock(),
        reset: () => runtime.current?.reset()
    }), [])

    useEffect(() => {
        if (!props.active || !props.interactive) {
            runtime.current?.clearKeys()
            runtime.current?.unlock()
        }
    }, [props.active, props.interactive])

    useEffect(() => {
        const host = hostRef.current
        if (!host) return
        const isCoarse = matchMedia("(pointer: coarse)").matches
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
        const abort = new AbortController()
        const scene = new THREE.Scene()
        scene.background = new THREE.Color("#111d22")
        scene.fog = new THREE.FogExp2("#14252b", 0.025)
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
        renderer.toneMappingExposure = 1.1
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFShadowMap
        const canvas = renderer.domElement
        canvas.tabIndex = 0
        canvas.setAttribute("aria-label", "Haunted library. Drag to look, use W A S D to walk, and E to speak to a nearby ghost.")
        canvas.dataset.testid = "library-canvas"
        host.appendChild(canvas)

        const spirits = new Map<MonsterId, Spirit>()
        let door: Spirit | null = null
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

        scene.add(new THREE.HemisphereLight("#8ebac9", "#38291b", 0.28))
        const moon = new THREE.DirectionalLight("#addfea", 2.4)
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
        const ghostFill = new THREE.PointLight("#a5d8e0", 10, 8, 2)
        ghostFill.position.set(-0.1, 3.8, -1.1)
        scene.add(ghostFill)

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
            if (!ready || !latest.current.active || !latest.current.interactive) return
            canvas.focus({ preventScroll: true })
            if (isCoarse || !canvas.requestPointerLock) { fallback(); return }
            try {
                const request = canvas.requestPointerLock()
                if (request && "catch" in request) request.catch(fallback)
            } catch { fallback() }
        }
        function reset() {
            clearKeys()
            camera.position.set(SPAWN.x, EYE_HEIGHT, SPAWN.z)
            camera.lookAt(aim)
            orientation.setFromQuaternion(camera.quaternion, "YXZ")
            needsRender = true
        }
        runtime.current = { lock, unlock, reset, clearKeys }

        function updateTarget(id: MonsterId | null) {
            if (hovered === id) return
            hovered = id
            latest.current.onTargetChange(id)
        }
        function selectAt(x: number, y: number): MonsterId | null {
            if (!ready || !latest.current.active || !latest.current.interactive) return null
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
            if (document.pointerLockElement === canvas && latest.current.interactive) look(event.movementX, event.movementY)
        }
        function onPointerDown(event: PointerEvent) {
            if (!latest.current.active || !latest.current.interactive) return
            canvas.focus({ preventScroll: true })
            if (document.pointerLockElement === canvas) return
            dragging = true; dragDistance = 0; pointerX = event.clientX; pointerY = event.clientY
            canvas.setPointerCapture(event.pointerId)
        }
        function onPointerMove(event: PointerEvent) {
            if (!dragging || document.pointerLockElement === canvas || !latest.current.interactive) return
            const dx = event.clientX - pointerX, dy = event.clientY - pointerY
            dragDistance += Math.abs(dx) + Math.abs(dy)
            look(dx, dy)
            pointerX = event.clientX; pointerY = event.clientY
        }
        function onPointerUp(event: PointerEvent) {
            if (!latest.current.interactive) return
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
            if (!latest.current.active || !latest.current.interactive || editable(event)) return
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
        function onVisibility() { if (document.hidden) clearKeys() }
        function onContextLost(event: Event) {
            event.preventDefault()
            failed = true
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
            aim.fromArray(manifest.camera.target)
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
            const entries = ["environment", ...IDS, "door"]
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
                prepare(gltf.scene, IDS.includes(id as MonsterId))
                scene.add(gltf.scene)
                if (IDS.includes(id as MonsterId)) {
                    gltf.scene.userData.monsterId = id
                    const spirit = animated(gltf)
                    spirits.set(id as MonsterId, spirit)
                    play(spirit, "Idle")
                    spirit.mixer.update(0.4 + IDS.indexOf(id as MonsterId) * 0.37)
                } else if (id === "door") door = animated(gltf)
                report(id, 1)
            })
            const sky = new HDRLoader().loadAsync(BASE + "forest.hdr", event => report("hdri", event.loaded / (event.total || weights.hdri))).then(texture => {
                if (disposed || failed) { texture.dispose(); return }
                hdri = texture
                texture.mapping = THREE.EquirectangularReflectionMapping
                environment = pmrem.fromEquirectangular(texture)
                scene.environment = environment.texture
                scene.environmentIntensity = 0.18
                scene.environmentRotation.y = THREE.MathUtils.degToRad(25)
                scene.background = texture
                scene.backgroundIntensity = 0.65
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
            const delta = Math.min((time - lastTime) / 1000, 0.05)
            lastTime = time
            if (failed || document.hidden) return
            const state = latest.current
            if (state.active && ready) {
                if (state.interactive) {
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
                flickerLights.forEach(({ light, base, phase }) => {
                    light.intensity = base * (1 + 0.035 * Math.sin(time * 0.0032 + phase) + 0.015 * Math.sin(time * 0.013 + phase))
                })
                needsRender = true
            }
            if (needsRender) { renderer.render(scene, camera); needsRender = false }
        }
        animationFrame = requestAnimationFrame(frame)

        return () => {
            disposed = true
            abort.abort()
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
        {dragFallback && !coarse && props.active && props.interactive && <div className="world-drag-hint">Drag to look · WASD to walk</div>}
        {coarse && props.active && props.interactive && <div className="world-touch-controls" aria-label="Walking controls">
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
