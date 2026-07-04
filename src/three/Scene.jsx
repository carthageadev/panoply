import { Suspense, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF, useTexture } from '@react-three/drei'
import * as THREE from 'three'

const SPACING = 3.6
const SIDE_SCALE = 0.58
const MODEL_ROT_Y = Math.PI // .glb exports facing away from camera; flip to show the label

// Resting pose from the design mockups: the featured cart leans back so its
// bottom connector shows; side carts angle inward toward the center.
const CENTER_PITCH = -0.42
const SIDE_PITCH = -0.05
const SIDE_YAW = 0.34

// Underdamped spring: quick slide with one subtle overshoot bounce,
// matching the reference footage of the carousel motion.
const SPRING_OMEGA = 19
const SPRING_ZETA = 0.62

function springStep(pos, vel, target, dt, omega = SPRING_OMEGA, zeta = SPRING_ZETA) {
  const accel = -omega * omega * (pos - target) - 2 * zeta * omega * vel
  const nextVel = vel + accel * dt
  return [pos + nextVel * dt, nextVel]
}

// Insert timeline (seconds): a bouncy hop above the row with a full spin —
// the rise overshoots its apex and springs back — then a fast, decisive drop
// into the "slot" at the bottom of the screen. The landing is dead solid (the
// cart is physically seated, it can't rebound) and it stays poking out
// part-way, N64 style, instead of vanishing off-screen.
const INSERT = { rise: 0.3, hang: 0.1, drop: 0.16 }
const INSERT_APEX_Y = 1.6
const INSERT_SLOT_Y = -1.7 // roughly a third of the cart buried below the screen edge

const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3)
const easeInQuad = (p) => p * p
// Fast launch that overshoots past 1 and springs back — the bouncy rise
const easeOutBack = (p) => 1 + 2.4 * Math.pow(p - 1, 3) + 1.4 * Math.pow(p - 1, 2)
const easeInOutQuad = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)
const CART_HEIGHT = 2.35 // world units the cartridge is normalized to
const FALLBACK_LABEL = '/image.png'

useGLTF.preload('/new-n64cart.glb')

// Loads a label texture with flipY=false (per the model spec) and falls
// back to the bundled example art if the remote fetch fails. The texture is
// force-uploaded to the GPU immediately — otherwise the upload would happen
// mid-frame the first time the cart scrolls into view (a visible hitch).
function useLabelTexture(url) {
  const gl = useThree((s) => s.gl)
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let alive = true
    const loader = new THREE.TextureLoader()
    const apply = (t) => {
      if (!alive) return
      t.flipY = false
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 8
      gl.initTexture(t)
      setTex(t)
    }
    loader.load(url || FALLBACK_LABEL, apply, undefined, () => {
      if (url) loader.load(FALLBACK_LABEL, apply)
    })
    return () => {
      alive = false
    }
  }, [url, gl])
  return tex
}

// `carousel` is a mutable store ({ platform, selected[], launching }) read
// directly by the frame loop. Selection/platform changes never re-render the
// Canvas tree — React only updates the HUD — so a keypress costs nothing here.
function Cartridge({ platformIndex, index, count, carousel, artUrl, onPick, onLaunch }) {
  const outer = useRef()
  const inner = useRef()
  const { scene } = useGLTF('/new-n64cart.glb')
  const gl = useThree((s) => s.gl)

  const body = useTexture({
    map: '/newbase.jpg',
    normalMap: '/newbase_Normal.tga.png',
    roughnessMap: '/newbase_Roughness.tga.png',
  })

  useMemo(() => {
    Object.values(body).forEach((t) => {
      t.flipY = false // spec: flipY=false for every texture on this model
      t.needsUpdate = true
    })
    body.map.colorSpace = THREE.SRGBColorSpace
    Object.values(body).forEach((t) => gl.initTexture(t)) // pre-upload to GPU
  }, [body, gl])

  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: body.map,
        normalMap: body.normalMap,
        roughnessMap: body.roughnessMap,
        metalness: 0.05,
      }),
    [body],
  )

  const labelTex = useLabelTexture(artUrl)
  const labelMat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.5 }), [])
  useEffect(() => {
    labelMat.map = labelTex
    labelMat.needsUpdate = true
  }, [labelTex, labelMat])

  // Clone the GLTF scene per cartridge, centered and normalized so layout
  // does not depend on the export scale of the .glb.
  const { model, normScale } = useMemo(() => {
    const clone = scene.clone(true)
    const box = new THREE.Box3().setFromObject(clone)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    clone.position.set(-center.x, -center.y, -center.z)
    return { model: clone, normScale: CART_HEIGHT / (size.y || 1) }
  }, [scene])

  useEffect(() => {
    model.traverse((obj) => {
      if (!obj.isMesh) return
      if (obj.name === 'model_2') obj.material = bodyMat
      else if (obj.name === 'boxart') obj.material = labelMat
    })
  }, [model, bodyMat, labelMat])

  const vel = useRef({ x: 0, y: 0, s: 0 })
  const rot = useRef({ pitch: 0, yaw: 0 })
  const launchStart = useRef(null)
  const settling = useRef(false) // post-insert return to the row: still rigid
  const uscale = useRef(1) // uniform base scale; squash/stretch is applied on top
  const reveal = useRef(1) // 0..1 fade progress for platform-switch crossfade
  const delayTimer = useRef(null) // staggers the reveal wave outward from center
  const prevY = useRef(0)

  useFrame((state, delta) => {
    if (!outer.current || !inner.current) return
    const t = state.clock.elapsedTime
    const dt = Math.min(delta, 1 / 30) // clamp so springs stay stable after tab switches
    const active = carousel.platform === platformIndex
    const offset = wrapOffset(index - carousel.selected[platformIndex], count)
    const launching = carousel.launching && active
    const isCenter = offset === 0
    const pos = outer.current.position

    const targetX = offset * SPACING
    const targetY = isCenter ? -0.1 : 0
    const targetZ = isCenter ? 0.45 : -0.85
    const targetScale = isCenter ? 1 : SIDE_SCALE

    const applyFade = () => {
      const a = THREE.MathUtils.clamp(reveal.current, 0, 1)
      const fading = a < 1
      if (bodyMat.transparent !== fading) {
        bodyMat.transparent = fading
        labelMat.transparent = fading
      }
      bodyMat.opacity = a
      labelMat.opacity = a
    }

    const shouldShow = active && Math.abs(offset) <= 2

    // Hidden carts stay mounted (no rebuild jank). Leaving carts fade out
    // briefly, then park just below their slot at half scale — so the next
    // reveal crossfades + pops ("pings") into place instead of hard-spawning.
    if (!shouldShow) {
      launchStart.current = null
      settling.current = false
      delayTimer.current = null
      if (reveal.current > 0 && outer.current.visible) {
        reveal.current = Math.max(0, reveal.current - dt / 0.09)
        pos.y -= dt * 1.4 // slight sink while fading out
        applyFade()
        if (reveal.current > 0) return
      }
      outer.current.visible = false
      pos.set(targetX, targetY - 1.2, targetZ)
      uscale.current = targetScale * 0.55
      outer.current.scale.setScalar(uscale.current)
      prevY.current = pos.y
      vel.current.x = vel.current.y = vel.current.s = 0
      rot.current.pitch = isCenter ? CENTER_PITCH : SIDE_PITCH
      rot.current.yaw = isCenter ? 0 : offset < 0 ? -SIDE_YAW : SIDE_YAW
      return
    }

    if (!outer.current.visible) {
      // staggered reveal: a quick wave rippling outward from the center slot
      if (delayTimer.current === null) delayTimer.current = Math.abs(offset) * 0.05
      delayTimer.current -= dt
      if (delayTimer.current > 0) return
      delayTimer.current = null
      outer.current.visible = true
      reveal.current = 0
      vel.current.s = 5 // stretch impulse — the "ping"
    }
    if (reveal.current < 1) reveal.current = Math.min(1, reveal.current + dt / 0.11)
    applyFade()

    // Springy slide with a hint of overshoot
    ;[pos.x, vel.current.x] = springStep(pos.x, vel.current.x, targetX, dt)
    pos.z += (targetZ - pos.z) * (1 - Math.pow(0.001, dt))
    const [s, sv] = springStep(uscale.current, vel.current.s, targetScale, dt, 16, 0.6)
    uscale.current = s
    vel.current.s = sv

    // Insert animation: choreographed y-path + full spin for the featured cart
    let spin = 0
    let flightTilt = 0
    const inFlight = launching && isCenter
    if (inFlight) {
      if (launchStart.current === null) launchStart.current = t
      const lt = t - launchStart.current
      const { rise, hang, drop } = INSERT
      if (lt < rise) {
        // Bouncy launch: shoots up fast, overshoots the apex, springs back
        pos.y = -0.1 + (INSERT_APEX_Y + 0.1) * easeOutBack(lt / rise)
      } else if (lt < rise + hang) {
        pos.y = INSERT_APEX_Y + Math.sin((lt - rise) * 14) * 0.03
      } else if (lt < rise + hang + drop) {
        // Fast accelerating drop straight into the slot
        const q = easeInQuad((lt - rise - hang) / drop)
        pos.y = INSERT_APEX_Y + (INSERT_SLOT_Y - INSERT_APEX_Y) * q
      } else {
        pos.y = INSERT_SLOT_Y // seated dead solid until App ends the launch
      }
      vel.current.y = 0
      const spinP = Math.min(lt / (rise + hang), 1)
      spin = 2 * Math.PI * easeInOutQuad(spinP)
      flightTilt = Math.sin(spinP * Math.PI) * 0.24
    } else {
      if (launchStart.current !== null) settling.current = true
      launchStart.current = null
      // After an insert the cart sits in the slot; the spring pops it back up.
      ;[pos.y, vel.current.y] = springStep(pos.y, vel.current.y, targetY, dt, 13, 0.7)
      if (settling.current && Math.abs(pos.y - targetY) < 0.04 && Math.abs(vel.current.y) < 0.2)
        settling.current = false
    }

    // Squash & stretch: elongate along vertical motion, squash sideways to
    // conserve volume. Platform-switch reveals only — a rigid cartridge being
    // inserted must NOT deform, so the insert flight is exempt.
    const vy = (pos.y - prevY.current) / Math.max(dt, 1e-4)
    prevY.current = pos.y
    const stretch =
      inFlight || settling.current ? 0 : Math.min(Math.abs(vy) * 0.028, 0.22)
    outer.current.scale.set(
      Math.max(0.01, uscale.current * (1 - stretch * 0.5)),
      Math.max(0.01, uscale.current * (1 + stretch)),
      Math.max(0.01, uscale.current * (1 - stretch * 0.5)),
    )

    // Smoothly blend toward the resting pose for this slot
    const targetPitch = inFlight ? 0 : isCenter ? CENTER_PITCH : SIDE_PITCH
    // Side carts sit on a carousel ring: they turn away from the center,
    // showing their inner flank (matches the design mockups)
    const targetYaw = inFlight || isCenter ? 0 : offset < 0 ? -SIDE_YAW : SIDE_YAW
    const kRot = 1 - Math.pow(0.002, dt)
    rot.current.pitch += (targetPitch - rot.current.pitch) * kRot
    rot.current.yaw += (targetYaw - rot.current.yaw) * kRot

    // Pose + gentle idle sway + launch spin. Sway phase is keyed on the
    // stable index (not offset) so selection changes can't pop the rotation.
    inner.current.rotation.x = rot.current.pitch + Math.sin(t * 0.8 + index) * 0.02
    inner.current.rotation.y =
      MODEL_ROT_Y +
      rot.current.yaw +
      spin +
      Math.sin(t * 0.55 + index * 1.7) * (isCenter ? 0.06 : 0.03)
    // Lean into the direction of travel, proportional to slide velocity
    inner.current.rotation.z =
      THREE.MathUtils.clamp(-vel.current.x * 0.045, -0.2, 0.2) + flightTilt
  })

  // Initial transform is set ONCE here; after mount the useFrame springs own
  // it exclusively. Passing position/scale as reactive props would make React
  // re-apply (teleport) them on every selection change — the carousel hitch.
  useLayoutEffect(() => {
    const active = carousel.platform === platformIndex
    const off = wrapOffset(index - carousel.selected[platformIndex], count)
    const isC = off === 0
    outer.current.visible = active && Math.abs(off) <= 2
    outer.current.position.set(
      off * SPACING,
      (isC ? -0.1 : 0) - (active ? 0 : 1.7),
      isC ? 0.45 : -0.85,
    )
    outer.current.scale.setScalar(isC ? 1 : SIDE_SCALE)
    rot.current.pitch = isC ? CENTER_PITCH : SIDE_PITCH
    rot.current.yaw = isC ? 0 : off < 0 ? -SIDE_YAW : SIDE_YAW
    uscale.current = outer.current.scale.x
    reveal.current = outer.current.visible ? 1 : 0
    prevY.current = outer.current.position.y
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <group
      ref={outer}
      onClick={(e) => {
        e.stopPropagation()
        if (carousel.platform !== platformIndex) return
        if (wrapOffset(index - carousel.selected[platformIndex], count) === 0) onLaunch()
        else onPick(index)
      }}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = 'auto')}
    >
      <group ref={inner} scale={normScale}>
        <primitive object={model} />
      </group>
    </group>
  )
}

// Wrap index distance so the carousel is endless in both directions.
function wrapOffset(rawOffset, count) {
  return rawOffset - Math.round(rawOffset / count) * count
}

// Eases the camera's zoom toward carousel.zoom (the "3D scale" setting):
// zoom > 1 gets closer/bigger, zoom < 1 pulls back for a wider scene.
function CameraRig({ carousel }) {
  const camera = useThree((s) => s.camera)
  useFrame((_, delta) => {
    const target = carousel.zoom || 1
    if (Math.abs(camera.zoom - target) < 0.001) return
    camera.zoom += (target - camera.zoom) * (1 - Math.pow(0.002, Math.min(delta, 1 / 30)))
    camera.updateProjectionMatrix()
  })
  return null
}

// memo + mutable carousel store: after label art has loaded, this component
// never re-renders again — arrow presses only touch the frame loop.
const Scene = memo(function Scene({ platforms, artMap, carousel, onPick, onLaunch }) {
  return (
    <Canvas
      className="scene-canvas"
      gl={{ alpha: true, antialias: true }}
      dpr={[1, 1.75]}
      camera={{ position: [0, 0.15, 7.4], fov: 35 }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
    >
      <CameraRig carousel={carousel} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 5, 6]} intensity={1.6} />
      <directionalLight position={[-5, 2, -3]} intensity={0.5} />
      <directionalLight position={[0, -3, 4]} intensity={0.25} />
      <Suspense fallback={null}>
        {/* ALL platforms' carts stay mounted; inactive/off-screen ones just
            hide — platform switches and scrolling never rebuild anything */}
        {platforms.flatMap((p, pi) =>
          p.games.map((game, gi) => (
            <Cartridge
              key={`${p.id}:${game.title}`}
              platformIndex={pi}
              index={gi}
              count={p.games.length}
              carousel={carousel}
              artUrl={artMap[`${p.id}:${game.title}`] || null}
              onPick={onPick}
              onLaunch={onLaunch}
            />
          )),
        )}
      </Suspense>
    </Canvas>
  )
})

export default Scene
