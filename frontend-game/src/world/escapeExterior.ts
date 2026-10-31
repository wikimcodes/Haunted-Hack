import * as THREE from "three"

export interface EscapeExterior {
    root: THREE.Group
    /** 0 before the door opens; 1 at full dawn. Does not change the library lighting. */
    update(progress: number): void
    /** Release the local shadow target before the world's shared mesh disposal. */
    dispose(): void
}

/**
 * A small, real 3D cloister beyond the library's east door. The centre stays flat and
 * unobstructed: x=4.3..14.8, z=-6.8..1.0. Boundary props sit beyond that walking area.
 * All resources are attached to root and can use the world's ordinary disposal pass.
 */
export function createEscapeExterior(library: THREE.Group, options: { doorCenterZ?: number } = {}): EscapeExterior {
    const root = new THREE.Group()
    root.name = "Escape courtyard — first light"
    root.visible = false
    const centreZ = options.doorCenterZ ?? -2.9
    let seed = 4117
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }

    const source = (pattern: RegExp) => {
        let found: THREE.MeshStandardMaterial | undefined
        library.traverse(object => {
            if (found || !(object instanceof THREE.Mesh)) return
            for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
                if (material instanceof THREE.MeshStandardMaterial && pattern.test(material.name)) { found = material; break }
            }
        })
        return found
    }
    const stone = source(/aged mauve stone/i)?.clone() ?? new THREE.MeshStandardMaterial()
    stone.name = "Courtyard | worn limestone from library"
    stone.color.set("#c6bba1")
    stone.roughness = .94
    stone.metalness = 0
    stone.envMapIntensity = .45
    stone.side = THREE.FrontSide
    const darkStone = stone.clone()
    darkStone.name = "Courtyard | damp stone edging"
    darkStone.color.set("#777e6c")
    const bark = source(/weathered dead bark/i)?.clone() ?? new THREE.MeshStandardMaterial({ color: "#4b4c38", roughness: 1 })
    bark.name = "Courtyard | weathered branches"
    bark.side = THREE.FrontSide
    const soil = new THREE.MeshStandardMaterial({ name: "Courtyard | settled earth", color: "#4d5140", roughness: 1, metalness: 0 })
    const moss = new THREE.MeshStandardMaterial({ name: "Courtyard | moss and grasses", color: "#66724b", roughness: .96, side: THREE.DoubleSide })
    const distant = new THREE.MeshBasicMaterial({ name: "Courtyard | misted distant hills", color: "#a6aaa0", fog: true })

    const box = new THREE.BoxGeometry(1, 1, 1)
    const dummy = new THREE.Object3D()
    type Instance = { position: [number, number, number]; scale: [number, number, number]; angle?: number; color?: THREE.Color }
    function instances(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, data: Instance[], shadows = true) {
        const mesh = new THREE.InstancedMesh(geometry, material, data.length)
        mesh.name = name
        data.forEach((item, i) => {
            dummy.position.fromArray(item.position)
            dummy.scale.fromArray(item.scale)
            dummy.rotation.set(0, item.angle ?? 0, 0)
            dummy.updateMatrix()
            mesh.setMatrixAt(i, dummy.matrix)
            if (item.color) mesh.setColorAt(i, item.color)
        })
        mesh.castShadow = shadows
        mesh.receiveShadow = true
        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        root.add(mesh)
        return mesh
    }
    function piece(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number], scale: [number, number, number] = [1, 1, 1]) {
        const mesh = new THREE.Mesh(geometry, material)
        mesh.name = name
        mesh.position.fromArray(position)
        mesh.scale.fromArray(scale)
        mesh.castShadow = true
        mesh.receiveShadow = true
        root.add(mesh)
        return mesh
    }

    // Flush with the library floor. Joint gaps are only visual, never missing terrain.
    piece("Courtyard foundation", box, soil, [9.65, -.17, -2.9], [13.5, .28, 10.4])
    piece("Doorway landing", box, stone, [4.3, -.03, centreZ], [1.2, .14, 2.5])
    const slabs: Instance[] = []
    for (let row = 0; row < 10; row++) {
        for (let column = 0; column < 13; column++) {
            const x = 3.94 + column * .94
            const z = -7.35 + row * .94
            const inPath = Math.abs(z - centreZ) < 1.1
            const shade = (inPath ? .92 : .72) + random() * .12
            slabs.push({ position: [x, -.025 - random() * .004, z], scale: [.89 + random() * .025, .12, .89 + random() * .025], angle: (random() - .5) * .009,
                color: new THREE.Color().setRGB(shade, shade, shade * .96) })
        }
    }
    instances("Irregular courtyard flags", box, stone, slabs)

    // Low enclosing walls, with slightly irregular courses and worn copings.
    const blocks: Instance[] = [], caps: Instance[] = []
    for (const z of [-7.55, 1.75]) {
        for (let course = 0; course < 3; course++) {
            for (let i = 0; i < 12; i++) {
                blocks.push({ position: [4.1 + i * 1.02 + (course % 2) * .22, .2 + course * .37, z], scale: [1.005, .355, .48], color: new THREE.Color().setScalar(.76 + random() * .22) })
            }
        }
        for (let i = 0; i < 13; i++) caps.push({ position: [3.97 + i * .99, 1.15, z], scale: [.98, .16, .65] })
    }
    // The far parapet is behind the completion threshold, never across the walk-out path.
    for (let i = 0; i < 10; i++) {
        blocks.push({ position: [16.05, .43, -7.2 + i * .94], scale: [.48, .86, .915], color: new THREE.Color().setScalar(.82 + random() * .14) })
        caps.push({ position: [16.05, .93, -7.2 + i * .94], scale: [.64, .15, .93] })
    }
    instances("Cloister parapet masonry", box, darkStone, blocks)
    instances("Worn coping stones", box, stone, caps)

    const pillars: Instance[] = [], pillarBases: Instance[] = []
    for (const z of [-7.55, 1.75]) {
        for (const x of [4.45, 8.05, 11.65, 15.25]) {
            pillars.push({ position: [x, 2.0, z], scale: [.38, 3.6, .38] })
            pillarBases.push({ position: [x, .18, z], scale: [.72, .36, .72] })
            pillarBases.push({ position: [x, 3.79, z], scale: [.61, .18, .61] })
            pillarBases.push({ position: [x, 3.97, z], scale: [.47, .18, .47] })
        }
    }
    instances("Cloister piers", box, darkStone, pillars)
    instances("Pier bases and capitals", box, stone, pillarBases)

    // Slender pointed arches connect the side piers. Their geometry is real and casts shadows.
    const arch = new THREE.Shape()
    arch.moveTo(-1.8, 0)
    arch.bezierCurveTo(-1.7, .72, -.67, 1.35, 0, 1.7)
    arch.bezierCurveTo(.67, 1.35, 1.7, .72, 1.8, 0)
    arch.lineTo(1.57, 0)
    arch.bezierCurveTo(1.43, .53, .55, 1.08, 0, 1.43)
    arch.bezierCurveTo(-.55, 1.08, -1.43, .53, -1.57, 0)
    arch.closePath()
    const archGeometry = new THREE.ExtrudeGeometry(arch, { depth: .32, bevelEnabled: true, bevelSize: .025, bevelThickness: .025, bevelSegments: 1, curveSegments: 10, steps: 1 })
    archGeometry.translate(0, 0, -.16)
    instances("Pointed stone arcade", archGeometry, stone, [-7.55, 1.75].flatMap(z => [6.25, 9.85, 13.45].map(x => ({ position: [x, 3.78, z] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }))))

    const beds: Instance[] = []
    for (const z of [-7.06, 1.25]) beds.push({ position: [9.8, -.025, z], scale: [11.3, .035, .35] })
    instances("Moss at courtyard edges", box, soil, beds, false)
    // Each blade narrows and bends towards its tip instead of presenting a flat rectangle.
    const bladeGeometry = new THREE.BufferGeometry()
    const bladePositions: number[] = [], bladeIndices: number[] = []
    for (let i = 0; i <= 5; i++) {
        const t = i / 5, width = .5 * Math.pow(1 - t, 1.2)
        bladePositions.push(.18 * t * t - width, t, .24 * t * t, .18 * t * t + width, t, .24 * t * t)
        if (i < 5) { const n = i * 2; bladeIndices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2) }
    }
    bladeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(bladePositions, 3))
    bladeGeometry.setIndex(bladeIndices)
    bladeGeometry.computeVertexNormals()
    const blades: Instance[] = []
    for (let i = 0; i < 1000; i++) {
        const z = i % 2 ? -7.03 - random() * .18 : 1.18 + random() * .2
        const x = 4.2 + random() * 11.25
        const height = .07 + Math.pow(random(), 1.7) * .31
        blades.push({ position: [x, .035, z], scale: [.025 + random() * .035, height, height], angle: random() * Math.PI * 2,
            color: new THREE.Color().setRGB(.65 + random() * .25, .7 + random() * .25, .49 + random() * .22) })
    }
    instances("Grass in the stone margins", bladeGeometry, moss, blades, false)

    // Curving, progressively tapered limbs form an irregular grove. All tubes share
    // one geometry/material, so finer branching costs triangles rather than drawcalls.
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = []
    function limb(curve: THREE.Curve<THREE.Vector3>, radius: number, segments: number, tipRadius = .002) {
        const geometry = new THREE.TubeGeometry(curve, segments, radius, 6, false)
        const points = geometry.getAttribute("position")
        for (let ring = 0; ring <= segments; ring++) {
            const t = ring / segments, centre = curve.getPointAt(t)
            const taper = (tipRadius + (radius - tipRadius) * Math.pow(1 - t, .85)) / radius
            for (let vertex = 0; vertex <= 6; vertex++) {
                const i = ring * 7 + vertex
                points.setXYZ(i, centre.x + (points.getX(i) - centre.x) * taper, centre.y + (points.getY(i) - centre.y) * taper, centre.z + (points.getZ(i) - centre.z) * taper)
            }
        }
        geometry.computeVertexNormals()
        const normal = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv"), offset = positions.length / 3
        for (let i = 0; i < points.count; i++) {
            positions.push(points.getX(i), points.getY(i), points.getZ(i))
            normals.push(normal.getX(i), normal.getY(i), normal.getZ(i))
            uvs.push(uv.getX(i), uv.getY(i))
        }
        for (const index of geometry.index!.array) indices.push(offset + index)
        geometry.dispose()
    }
    const treesAt = [[18.8, -6.7, 6.4], [20.2, .6, 7.3], [24.8, -2.9, 8.8], [11.2, -11.5, 7.5], [9.7, 6.7, 7], [28, 4.3, 8.2]]
    for (const [x, z, height] of treesAt) {
        const phase = random() * Math.PI * 2, leanX = (random() - .5) * 1.6, leanZ = (random() - .5) * 1.8
        const trunkPoints = Array.from({ length: 8 }, (_, i) => {
            const t = i / 7
            return new THREE.Vector3(x + leanX * t * t + Math.sin(t * 5 + phase) * .24 * t, -.2 + height * t, z + leanZ * t * t + Math.cos(t * 4.3 + phase) * .3 * t)
        })
        const trunk = new THREE.CatmullRomCurve3(trunkPoints)
        limb(trunk, .22 + random() * .08, 18, .009)
        const count = 8 + Math.floor(random() * 4)
        for (let i = 0; i < count; i++) {
            const join = .22 + (i + random() * .6) / count * .65
            const start = trunk.getPointAt(join)
            const angle = phase + i * 2.399 + (random() - .5) * .8
            const length = height * (.39 - join * .2) * (.72 + random() * .45)
            const out = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle))
            const end = start.clone().addScaledVector(out, length).add(new THREE.Vector3((random() - .5) * .5, length * (.55 + random() * .35), (random() - .5) * .4))
            const middleA = start.clone().addScaledVector(out, length * .35).add(new THREE.Vector3(0, -.12 + random() * .2, 0))
            const middleB = end.clone().addScaledVector(out, -length * .3).add(new THREE.Vector3(0, -length * .48, 0))
            const primary = new THREE.CubicBezierCurve3(start, middleA, middleB, end)
            limb(primary, .095 * (1 - join * .6), 9, .005)
            for (let side = 0; side < 3; side++) {
                const at = .35 + side * .2 + random() * .09
                const rootPoint = primary.getPointAt(at)
                const reach = length * (.26 + random() * .24)
                const split = angle + (side % 2 ? -1 : 1) * (.5 + random() * .55)
                const direction = new THREE.Vector3(Math.cos(split), .75 + random() * .65, Math.sin(split))
                const tip = rootPoint.clone().addScaledVector(direction, reach)
                const secondary = new THREE.CubicBezierCurve3(rootPoint, rootPoint.clone().addScaledVector(direction, reach * .25), tip.clone().add(new THREE.Vector3(-.12, -reach * .5, .08)), tip)
                limb(secondary, .026 * (1 - at * .45), 7, .0015)
                const twigStart = secondary.getPointAt(.55 + random() * .17)
                const twigTip = twigStart.clone().add(new THREE.Vector3(Math.cos(split + .8) * reach * .42, reach * .58, Math.sin(split + .8) * reach * .42))
                limb(new THREE.CatmullRomCurve3([twigStart, twigStart.clone().lerp(twigTip, .5).add(new THREE.Vector3(.05, -.04, -.05)), twigTip]), .008, 4, .0008)
            }
        }
    }
    const branchGeometry = new THREE.BufferGeometry()
    branchGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    branchGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
    branchGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
    branchGeometry.setAttribute("uv1", new THREE.Float32BufferAttribute(uvs, 2))
    branchGeometry.setIndex(indices)
    branchGeometry.computeBoundingSphere()
    const trees = new THREE.Mesh(branchGeometry, bark)
    trees.name = "Bare trees beyond the cloister"
    trees.castShadow = true
    trees.receiveShadow = true
    root.add(trees)

    // Soft, low silhouettes sit farther into the haze instead of towering faceted mounds.
    const hillGeometry = new THREE.SphereGeometry(1, 40, 18)
    instances("Distant hillside silhouettes", hillGeometry, distant, [
        { position: [43, -2.8, -17], scale: [20, 4.2, 15] },
        { position: [50, -3.2, 4], scale: [23, 4.6, 19] },
        { position: [32, -3.1, 26], scale: [20, 4.1, 17] },
        { position: [15, -3.1, -33], scale: [19, 3.9, 19] },
    ], false)
    piece("Ground beyond the courtyard", box, soil, [17, -.45, -3], [50, .3, 58])

    const sky = new THREE.Mesh(new THREE.SphereGeometry(72, 24, 12), new THREE.ShaderMaterial({
        name: "Courtyard | dawn sky",
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { top: { value: new THREE.Color("#829ba4") }, horizon: { value: new THREE.Color("#e8cfaa") }, sunDirection: { value: new THREE.Vector3(.95, .12, -.24).normalize() } },
        vertexShader: "varying vec3 vDirection; void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader: `varying vec3 vDirection; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDirection;
            void main(){
                vec3 direction=normalize(vDirection);
                float altitude=smoothstep(-0.08,0.65,direction.y);
                vec3 colour=mix(horizon,top,altitude);
                float facing=max(0.0,dot(direction,sunDirection));
                colour+=vec3(0.3,0.19,0.07)*pow(facing,28.0);
                colour+=vec3(0.7,0.57,0.3)*smoothstep(0.99955,0.9999,facing);
                gl_FragColor=vec4(colour,1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
    }))
    sky.name = "Dawn beyond the library"
    sky.position.set(9, 0, -3)
    sky.renderOrder = -10
    root.add(sky)

    // Both sources have finite range. The sun washes the outside stone rather than
    // replacing the library's whole-world night lighting with a global hemisphere.
    const sunlight = new THREE.SpotLight("#ffe1ac", 0, 35, .85, .9, 1.1)
    sunlight.name = "Courtyard morning light"
    sunlight.position.set(18, 11, -3)
    sunlight.target.position.set(7, 0, centreZ)
    sunlight.castShadow = true
    sunlight.shadow.mapSize.set(1024, 1024)
    sunlight.shadow.bias = -.00015
    sunlight.shadow.normalBias = .025
    sunlight.shadow.camera.near = .5
    sunlight.shadow.camera.far = 35
    root.add(sunlight, sunlight.target)
    const skyFill = new THREE.PointLight("#b6cccf", 0, 18, 1.5)
    skyFill.name = "Courtyard open sky fill"
    skyFill.position.set(9, 6.5, -2.8)
    root.add(skyFill)

    return {
        root,
        update(progress) {
            const amount = THREE.MathUtils.clamp(progress, 0, 1)
            sunlight.intensity = 85 * amount
            skyFill.intensity = 46 * amount
        },
        dispose() { sunlight.shadow.dispose() },
    }
}
