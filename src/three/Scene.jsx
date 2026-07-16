import {
  Suspense,
  memo,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { Html, useGLTF, useTexture } from '@react-three/drei'
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

useGLTF.setDecoderPath('/draco/')
useGLTF.preload('/new-n64cart.glb')

// Label images decode asynchronously, then enter a shared GPU queue. The queue
// uploads at most one texture every few frames, avoiding both startup bursts
// and a first-scroll upload hitch.
function useLabelTexture(url, fallback, textureQueue) {
  const [tex, setTex] = useState(fallback)
  useEffect(() => {
    let alive = true
    let loaded = null
    setTex(fallback)
    if (!url) return () => {}

    const apply = (t) => {
      loaded = t
      if (!alive) {
        t.image?.close?.()
        t.dispose()
        return
      }
      t.flipY = false
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 8
      textureQueue.push((gl) => {
        if (!alive) return
        gl.initTexture(t)
        setTex(t)
      })
    }
    if ('createImageBitmap' in window) {
      const loader = new THREE.ImageBitmapLoader()
      loader.setOptions({ imageOrientation: 'from-image', premultiplyAlpha: 'none' })
      loader.load(url, (bitmap) => {
        const texture = new THREE.Texture(bitmap)
        texture.needsUpdate = true
        apply(texture)
      })
    } else {
      new THREE.TextureLoader().load(url, apply)
    }
    return () => {
      alive = false
      loaded?.image?.close?.()
      loaded?.dispose()
    }
  }, [url, fallback, textureQueue])
  return tex
}

function TextureWarmup({ queue }) {
  const gl = useThree((s) => s.gl)
  const lastUpload = useRef(-Infinity)
  useFrame((state) => {
    if (!queue.length || state.clock.elapsedTime - lastUpload.current < 0.06) return
    const upload = queue.shift()
    upload(gl)
    lastUpload.current = state.clock.elapsedTime
  })
  return null
}

// `carousel` is a mutable store ({ platform, selected[], launching }) read
// directly by the frame loop. Selection/platform changes never re-render the
// Canvas tree — React only updates the HUD — so a keypress costs nothing here.
const Cartridge = memo(function Cartridge({
  platformIndex,
  index,
  count,
  carousel,
  artUrl,
  artStatus,
  onPick,
  onLaunch,
  bodyNode,
  labelNode,
  modelOffset,
  normScale,
  body,
  fallbackLabel,
  textureQueue,
  progressive,
}) {
  const outer = useRef()
  const inner = useRef()
  const statusInView = useRef(false)
  const [isInView, setIsInView] = useState(false)
  const [statusPhase, setStatusPhase] = useState('visible')
  const fetchState = artStatus?.state || 'queued'
  const fetchLabel =
    fetchState === 'ready'
      ? 'ART OK'
      : fetchState === 'loading'
        ? 'FETCHING'
        : fetchState === 'error'
          ? 'ART ERROR'
          : 'QUEUED'
  const fetchIcon = fetchState === 'ready' ? '✓' : fetchState === 'error' ? '!' : '…'

  useEffect(() => {
    let fadeTimer
    let removeTimer
    setStatusPhase('visible')
    if (fetchState === 'ready') {
      fadeTimer = setTimeout(() => setStatusPhase('fading'), 3000)
      removeTimer = setTimeout(() => setStatusPhase('hidden'), 3350)
    }
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(removeTimer)
    }
  }, [fetchState])

  const setStatusInView = (visible) => {
    if (statusInView.current === visible) return
    statusInView.current = visible
    setIsInView(visible)
  }

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

  const labelTex = useLabelTexture(artUrl, fallbackLabel, textureQueue)
  const labelMat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.5 }), [])
  const disposeTimer = useRef(null)
  useEffect(() => {
    labelMat.map = labelTex
    labelMat.needsUpdate = true
  }, [labelTex, labelMat])

  useEffect(() => {
    // Delay disposal by a task so React StrictMode's setup/cleanup/setup cycle
    // can cancel it instead of invalidating materials that are still in use.
    clearTimeout(disposeTimer.current)
    return () => {
      disposeTimer.current = setTimeout(() => {
        bodyMat.dispose()
        labelMat.dispose()
      })
    }
  }, [bodyMat, labelMat])

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
    if (!active && !outer.current.visible) return
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
      setStatusInView(false)
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
      setStatusInView(true)
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
    const initiallyVisible = active && Math.abs(off) <= 2
    outer.current.visible = initiallyVisible && !progressive
    statusInView.current = outer.current.visible
    setIsInView(outer.current.visible)
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
        <group position={modelOffset}>
          <mesh
            geometry={bodyNode.geometry}
            material={bodyMat}
            position={bodyNode.position}
            quaternion={bodyNode.quaternion}
            scale={bodyNode.scale}
            dispose={null}
          />
          <mesh
            geometry={labelNode.geometry}
            material={labelMat}
            position={labelNode.position}
            quaternion={labelNode.quaternion}
            scale={labelNode.scale}
            dispose={null}
          />
        </group>
      </group>
      {isInView && statusPhase !== 'hidden' && (
        <Html position={[0, 1.52, 0]} center distanceFactor={8} zIndexRange={[20, 0]}>
          <div
            className={`art-status art-status-${fetchState}${
              statusPhase === 'fading' ? ' art-status-fade-out' : ''
            }`}
            title={artStatus?.message || `Label art ${fetchState}`}
            aria-label={artStatus?.message || `Label art ${fetchState}`}
          >
            <span className="art-status-icon">{fetchIcon}</span>
            <span>{fetchLabel}</span>
          </div>
        </Html>
      )}
    </group>
  )
})

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

function SceneContents({ platforms, artMap, artStatus, carousel, onPick, onLaunch }) {
  const { scene } = useGLTF('/new-n64cart.glb')
  const gl = useThree((s) => s.gl)
  const [mapImage, normalImage, roughnessImage] = useLoader(
    THREE.ImageBitmapLoader,
    ['/newbase.jpg', '/newbase_Normal.tga.png', '/newbase_Roughness.tga.png'],
    (loader) =>
      loader.setOptions({
        imageOrientation: 'from-image',
        premultiplyAlpha: 'none',
        resizeWidth: 1024,
        resizeHeight: 1024,
        resizeQuality: 'high',
      }),
  )
  const body = useMemo(
    () => ({
      map: new THREE.Texture(mapImage),
      normalMap: new THREE.Texture(normalImage),
      roughnessMap: new THREE.Texture(roughnessImage),
    }),
    [mapImage, normalImage, roughnessImage],
  )
  const fallbackLabel = useTexture(FALLBACK_LABEL)
  const textureQueue = useMemo(() => [], [])

  // The GLTF has two root meshes. Reuse their decoded geometries and transforms
  // directly instead of cloning/traversing the 18k-vertex scene per cartridge.
  const { bodyNode, labelNode, modelOffset, normScale } = useMemo(() => {
    const bodyMesh = scene.getObjectByName('model_2')
    const labelMesh = scene.getObjectByName('boxart')
    const box = new THREE.Box3().setFromObject(scene)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    return {
      bodyNode: bodyMesh,
      labelNode: labelMesh,
      modelOffset: center.multiplyScalar(-1),
      normScale: CART_HEIGHT / (size.y || 1),
    }
  }, [scene])

  useLayoutEffect(() => {
    body.map.colorSpace = THREE.SRGBColorSpace
    Object.values(body).forEach((t) => {
      t.flipY = false
      t.needsUpdate = true
      gl.initTexture(t)
    })
    fallbackLabel.flipY = false
    fallbackLabel.colorSpace = THREE.SRGBColorSpace
    fallbackLabel.anisotropy = 8
    fallbackLabel.needsUpdate = true
    gl.initTexture(fallbackLabel)
  }, [body, fallbackLabel, gl])

  const firstKey = useRef(
    `${platforms[carousel.platform].id}:${
      platforms[carousel.platform].games[carousel.selected[carousel.platform]].title
    }`,
  ).current
  const [mountedKeys, setMountedKeys] = useState(() => new Set([firstKey]))

  useEffect(() => {
    const remaining = platforms
      .flatMap((p, platformIndex) =>
        p.games.map((game, gameIndex) => ({
          key: `${p.id}:${game.title}`,
          platformIndex,
          gameIndex,
        })),
      )
      .filter(({ key }) => key !== firstKey)
      .sort((a, b) => {
        const score = ({ platformIndex, gameIndex }) =>
          (platformIndex === carousel.platform ? 0 : 100 + platformIndex * 10) +
          Math.min(
            Math.abs(gameIndex - carousel.selected[platformIndex]),
            platforms[platformIndex].games.length -
              Math.abs(gameIndex - carousel.selected[platformIndex]),
          )
        return score(a) - score(b)
      })

    let idleId
    let timerId
    let stopped = false
    const mountOne = () => {
      if (stopped || !remaining.length) return
      const { key } = remaining.shift()
      startTransition(() => {
        setMountedKeys((current) => {
          const next = new Set(current)
          next.add(key)
          return next
        })
      })
      timerId = setTimeout(schedule, 55)
    }
    const schedule = () => {
      if (stopped || !remaining.length) return
      const next = remaining[0]
      const distance = Math.abs(
        wrapOffset(next.gameIndex - carousel.selected[next.platformIndex], platforms[next.platformIndex].games.length),
      )
      // The initial five visible slots should arrive promptly and animate in;
      // invisible background carts can wait for genuine browser idle time.
      if (next.platformIndex === carousel.platform && distance <= 2)
        timerId = setTimeout(mountOne, 70)
      else if ('requestIdleCallback' in window)
        idleId = window.requestIdleCallback(mountOne, { timeout: 250 })
      else timerId = setTimeout(mountOne, 70)
    }
    schedule()
    return () => {
      stopped = true
      clearTimeout(timerId)
      if (idleId !== undefined && 'cancelIdleCallback' in window)
        window.cancelIdleCallback(idleId)
    }
  }, [platforms, carousel, firstKey])

  return (
    <>
      <TextureWarmup queue={textureQueue} />
      {platforms.flatMap((p, pi) =>
        p.games.map((game, gi) => {
          const key = `${p.id}:${game.title}`
          if (!mountedKeys.has(key)) return null
          return (
            <Cartridge
              key={key}
              platformIndex={pi}
              index={gi}
              count={p.games.length}
              carousel={carousel}
              artUrl={artMap[key] || null}
              artStatus={artStatus[key]}
              onPick={onPick}
              onLaunch={onLaunch}
              bodyNode={bodyNode}
              labelNode={labelNode}
              modelOffset={modelOffset}
              normScale={normScale}
              body={body}
              fallbackLabel={fallbackLabel}
              textureQueue={textureQueue}
              progressive={key !== firstKey}
            />
          )
        }),
      )}
    </>
  )
}

// memo + mutable carousel store: after label art has loaded, this component
// never re-renders again — arrow presses only touch the frame loop.
const Scene = memo(function Scene({ platforms, artMap, artStatus, carousel, onPick, onLaunch }) {
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
        <SceneContents
          platforms={platforms}
          artMap={artMap}
          artStatus={artStatus}
          carousel={carousel}
          onPick={onPick}
          onLaunch={onLaunch}
        />
      </Suspense>
    </Canvas>
  )
})

export default Scene
