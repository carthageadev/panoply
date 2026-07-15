import { useCallback, useEffect, useRef, useState } from 'react'
import Scene from './three/Scene.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import { PLATFORMS } from './data/games.js'
import { fetchLabelUrl, cachedLabelUrl, fetchWithRetry } from './lib/screenscraper.js'
import { getCachedArt, putCachedArt } from './lib/artCache.js'

function useClock() {
  const [time, setTime] = useState('')
  useEffect(() => {
    const tick = () => {
      const d = new Date()
      setTime(
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      )
    }
    tick()
    const id = setInterval(tick, 10_000)
    return () => clearInterval(id)
  }, [])
  return time
}

function Glyph({ children }) {
  return <span className="glyph">{children}</span>
}

function BatteryIcon() {
  const [level, setLevel] = useState(1)
  const [charging, setCharging] = useState(true)
  useEffect(() => {
    if (!navigator.getBattery) return
    let battery
    let disposed = false
    let update
    navigator
      .getBattery()
      .then((b) => {
        if (disposed) return
        battery = b
        update = () => {
          setLevel(b.level)
          setCharging(b.charging)
        }
        update()
        b.addEventListener('levelchange', update)
        b.addEventListener('chargingchange', update)
      })
      .catch(() => {})
    return () => {
      disposed = true
      if (!battery || !update) return
      battery.removeEventListener('levelchange', update)
      battery.removeEventListener('chargingchange', update)
    }
  }, [])
  return (
    <svg width="26" height="14" viewBox="0 0 26 14" aria-label="battery">
      <rect x="0.5" y="0.5" width="22" height="13" rx="3" fill="none" stroke="currentColor" />
      <rect x="23.5" y="4" width="2.5" height="6" rx="1" fill="currentColor" />
      <rect x="2.5" y="2.5" width={Math.max(2, 18 * level)} height="9" rx="1.5" fill="currentColor" />
      {charging && (
        <path d="M12 1 L8 8 h3 l-1 5 4 -7 h-3 z" fill="var(--bg)" stroke="none" />
      )}
    </svg>
  )
}

function WifiIcon() {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-label="wifi">
      <path d="M9 12.5 L11.4 9.6 a4 4 0 0 0 -4.8 0 Z" fill="currentColor" />
      <path d="M3.6 6.5 a8 8 0 0 1 10.8 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M1 3.6 a12 12 0 0 1 16 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

export default function App() {
  const time = useClock()
  // Dev helper: ?platform=<index> boots into another platform
  const initialPlatform = useRef(
    Math.min(
      PLATFORMS.length - 1,
      Number(new URLSearchParams(window.location.search).get('platform')) || 0,
    ),
  ).current
  const [platformIndex, setPlatformIndex] = useState(initialPlatform)
  // Selection is remembered per platform; boot focuses the featured game
  const [gameIndices, setGameIndices] = useState(() => PLATFORMS.map((_, i) => (i === 0 ? 1 : 0)))
  const gameIndex = gameIndices[platformIndex]
  const platformRef = useRef(0)
  platformRef.current = platformIndex
  const setGameIndex = useCallback((updater) => {
    setGameIndices((prev) =>
      prev.map((v, i) =>
        i === platformRef.current ? (typeof updater === 'function' ? updater(v) : updater) : v,
      ),
    )
  }, [])
  const [artMap, setArtMap] = useState({})
  const [overlay, setOverlay] = useState(
    () => new URLSearchParams(window.location.search).get('overlay'),
  ) // null | settings | apps | inspect
  const [overlayClosing, setOverlayClosing] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [toast, setToast] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('cs-theme') || 'light')
  // Dev helpers ?uiscale= / ?zoom= override the persisted values
  const [uiScale, setUiScale] = useState(
    () =>
      Number(new URLSearchParams(window.location.search).get('uiscale')) ||
      Number(localStorage.getItem('cs-ui-scale')) ||
      1,
  )
  const [sceneZoom, setSceneZoom] = useState(
    () =>
      Number(new URLSearchParams(window.location.search).get('zoom')) ||
      Number(localStorage.getItem('cs-3d-scale')) ||
      1,
  )
  const toastTimer = useRef(null)
  const [artEpoch, setArtEpoch] = useState(0) // bump to re-run the art fetch queue
  const artUrls = useRef(new Map())

  const platform = PLATFORMS[platformIndex]
  const games = platform.games
  const game = games[gameIndex]

  // Mutable store read by the 3D frame loop directly; keeps the memoized
  // Scene from re-rendering on selection/platform changes (the keypress hitch).
  const carousel = useRef({
    platform: initialPlatform,
    selected: PLATFORMS.map((_, i) => (i === 0 ? 1 : 0)),
    launching: false,
    zoom: Number(localStorage.getItem('cs-3d-scale')) || 1,
  }).current
  useEffect(() => {
    carousel.platform = platformIndex
    gameIndices.forEach((v, i) => {
      carousel.selected[i] = v
    })
  }, [platformIndex, gameIndices, carousel])
  useEffect(() => {
    carousel.launching = launching
  }, [launching, carousel])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('cs-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(uiScale))
    localStorage.setItem('cs-ui-scale', String(uiScale))
  }, [uiScale])

  useEffect(() => {
    carousel.zoom = sceneZoom // camera rig eases toward this each frame
    localStorage.setItem('cs-3d-scale', String(sceneZoom))
  }, [sceneZoom, carousel])

  const toastId = useRef(0)
  const showToast = useCallback((msg) => {
    // keyed by id so each toast remounts and replays its in/out animation
    setToast({ id: ++toastId.current, msg })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }, [])

  // Menus animate out before unmounting (console-style), so closing goes
  // through a brief "closing" phase that plays the exit animation.
  const openOverlay = useCallback((name) => {
    setOverlayClosing(false)
    setOverlay(name)
  }, [])
  const closeOverlay = useCallback(() => {
    setOverlayClosing((already) => {
      if (!already) setTimeout(() => {
        setOverlay(null)
        setOverlayClosing(false)
      }, 100)
      return true
    })
  }, [])
  const overlayClass = `overlay${overlayClosing ? ' closing' : ''}`

  // Load the selected platform/nearby games first, then warm the rest one at a
  // time. Yielding between publishes prevents cached blobs from causing a burst
  // of React work, image decoding and GPU uploads in the first few frames.
  // Three cache layers, checked in order:
  //   1. IndexedDB image blobs  -> zero network, art loads fully offline
  //   2. localStorage media URL -> skips the two API lookup calls
  //   3. live API search        -> first time only; result feeds caches 1+2
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const pending = PLATFORMS.flatMap((p, platformIndex) =>
      p.games.map((g, gameIndex) => ({ p, g, platformIndex, gameIndex })),
    )

    const nextFrame = () =>
      new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 24)))

    const publish = (key, blob) => {
      const objectUrl = URL.createObjectURL(blob)
      const previous = artUrls.current.get(key)
      artUrls.current.set(key, objectUrl)
      setArtMap((prev) => ({ ...prev, [key]: objectUrl }))
      // Give React and any <img> consumer time to commit the replacement.
      if (previous)
        requestAnimationFrame(() => requestAnimationFrame(() => URL.revokeObjectURL(previous)))
    }

    ;(async () => {
      while (pending.length) {
        if (signal.aborted) return
        // Re-evaluate priority each turn so switching platform moves its labels
        // to the front without starting a second concurrent queue.
        pending.sort((a, b) => {
          const score = ({ platformIndex, gameIndex }) =>
            (platformIndex === platformRef.current ? 0 : 100 + platformIndex * 10) +
            Math.min(
              Math.abs(gameIndex - carousel.selected[platformIndex]),
              PLATFORMS[platformIndex].games.length -
                Math.abs(gameIndex - carousel.selected[platformIndex]),
            )
          return score(a) - score(b)
        })
        const { p, g } = pending.shift()
        const key = `${p.id}:${g.title}`
        const blobKey = `${p.systemId}:${g.title}`
        try {
          let blob = await getCachedArt(blobKey)
          if (!blob) {
            const url =
              cachedLabelUrl(p.systemId, g.title) ||
              (await fetchLabelUrl(g.title, p.systemId, g.search || g.title, { signal }))
            const resp = await fetchWithRetry(url, { signal })
            const type = resp.headers.get('content-type') || ''
            if (!resp.ok || !type.startsWith('image')) throw new Error('bad image response')
            blob = await resp.blob()
            await putCachedArt(blobKey, blob)
          }
          if (!signal.aborted) publish(key, blob)
        } catch (error) {
          if (error?.name === 'AbortError') return
          /* keep fallback label for this game */
        }
        await nextFrame()
      }
    })()
    return () => {
      controller.abort()
    }
  }, [artEpoch, carousel])

  // Blob URLs live outside React/JS garbage collection and must be released.
  useEffect(
    () => () => {
      artUrls.current.forEach((url) => URL.revokeObjectURL(url))
      artUrls.current.clear()
    },
    [],
  )

  const move = useCallback(
    (dir) => {
      if (launching) return // keep the flying cart in its slot mid-insert
      setGameIndex((i) => (i + dir + games.length) % games.length)
    },
    [games.length, launching],
  )

  const cyclePlatform = useCallback(
    (dir) => {
      if (PLATFORMS.length < 2) {
        showToast('Only one platform yet — add more soon!')
        return
      }
      // per-platform selection is remembered; no reset needed
      setPlatformIndex((i) => (i + dir + PLATFORMS.length) % PLATFORMS.length)
    },
    [showToast],
  )

  const launch = useCallback(() => {
    if (launching) return
    setLaunching(true)
    showToast(`Inserting ${game.title}…`)
    setTimeout(() => setLaunching(false), 950) // rise + spin + drop + a beat seated in the slot
  }, [game.title, launching, showToast])

  // Identity-stable handlers for the memoized Scene
  const launchFnRef = useRef(launch)
  launchFnRef.current = launch
  const handleLaunch = useCallback(() => launchFnRef.current(), [])
  const handlePick = useCallback(
    (i) => {
      if (!carousel.launching) setGameIndex(i)
    },
    [carousel],
  )

  // Dev helper: ?autolaunch=<ms> triggers the insert animation after load
  useEffect(() => {
    const delay = new URLSearchParams(window.location.search).get('autolaunch')
    if (!delay) return
    const id = setTimeout(launch, Number(delay))
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') {
        closeOverlay()
        return
      }
      if (overlay) return
      switch (e.key) {
        case 'ArrowLeft':
          move(-1)
          break
        case 'ArrowRight':
          move(1)
          break
        case 'Enter':
        case 'a':
          launch()
          break
        case 'l':
          cyclePlatform(-1)
          break
        case 'r':
          cyclePlatform(1)
          break
        case 'y':
          openOverlay('settings')
          break
        case 'b':
          openOverlay('apps')
          break
        case 'x':
          openOverlay('inspect')
          break
        default:
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move, launch, cyclePlatform, overlay, openOverlay, closeOverlay])

  return (
    <div className="app">
      <Scene
        platforms={PLATFORMS}
        artMap={artMap}
        carousel={carousel}
        onPick={handlePick}
        onLaunch={handleLaunch}
      />

      {/* ---- top HUD ---- */}
      <header className="hud hud-top">
        <div className="pill pill-dark clock corner-left">{time}</div>
        <div className="platform-switch">
          <button
            className="chip chip-l"
            onClick={() => cyclePlatform(-1)}
            title="Previous platform (L)"
          >
            <span className="key">L</span>
          </button>
          <div key={platform.name} className="pill pill-white platform-name swap-in">
            {platform.name}
          </div>
          <button
            className="chip chip-r"
            onClick={() => cyclePlatform(1)}
            title="Next platform (R)"
          >
            <span className="key">R</span>
          </button>
        </div>
        <div className="pill pill-dark status-pill corner-right">
          <BatteryIcon />
          <WifiIcon />
        </div>
      </header>

      {/* ---- game title ---- */}
      <div className="hud hud-title">
        <button key={game.title} className="pill pill-white title-pill swap-in" onClick={launch}>
          <Glyph>A</Glyph>
          {game.title}
        </button>
      </div>

      {/* ---- bottom HUD ---- */}
      <footer className="hud hud-bottom">
        <button className="pill pill-grey corner-left" onClick={() => openOverlay('settings')}>
          <Glyph>Y</Glyph>Settings
        </button>
        <div className="hud-bottom-right">
          <button className="pill pill-grey" onClick={() => openOverlay('apps')}>
            <Glyph>B</Glyph>Apps
          </button>
          <button className="pill pill-grey corner-right" onClick={() => openOverlay('inspect')}>
            <Glyph>X</Glyph>Inspect
          </button>
        </div>
      </footer>

      {toast && (
        <div key={toast.id} className="toast pill pill-dark">
          {toast.msg}
        </div>
      )}

      {overlay === 'settings' && (
        <SettingsPanel
          platform={platform}
          artMap={artMap}
          theme={theme}
          setTheme={setTheme}
          uiScale={uiScale}
          setUiScale={setUiScale}
          sceneZoom={sceneZoom}
          setSceneZoom={setSceneZoom}
          showToast={showToast}
          onRescan={() => setArtEpoch((n) => n + 1)}
          closing={overlayClosing}
          onClose={closeOverlay}
        />
      )}

      {overlay === 'inspect' && (
        <div className={overlayClass} onClick={closeOverlay}>
          <div className="card inspect-card" onClick={(e) => e.stopPropagation()}>
            <h2>{game.title}</h2>
            <img
              className="inspect-art"
              src={artMap[`${platform.id}:${game.title}`] || '/image.png'}
              alt={`${game.title} label art`}
            />
            <p className="muted">Platform: {platform.name}</p>
            <p className="muted">
              Label art:{' '}
              {artMap[`${platform.id}:${game.title}`] ? 'ScreenScraper (cached)' : 'fallback sample'}
            </p>
            <div className="card-actions">
              <button className="pill pill-red" onClick={closeOverlay}>
                <Glyph>Ⓑ</Glyph>Close
              </button>
            </div>
          </div>
        </div>
      )}

      {overlay === 'apps' && (
        <div className={overlayClass} onClick={closeOverlay}>
          <div className="card apps-card" onClick={(e) => e.stopPropagation()}>
            <h2>Apps</h2>
            <div className="apps-grid">
              {['Emulator', 'Music', 'Gallery', 'Browser'].map((name) => (
                <button
                  key={name}
                  className="app-tile"
                  onClick={() => showToast(`${name} — coming soon!`)}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="card-actions">
              <button className="pill pill-red" onClick={closeOverlay}>
                <Glyph>Ⓑ</Glyph>Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
