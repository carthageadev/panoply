// ScreenScraper v2 API client — follows "3d model and api spec.md":
//   Phase 1: jeuRecherche.php  -> game id
//   Phase 2: jeuInfos.php      -> medias
//   Phase 3: pick media type "support-texture", region wor > us > eu > ss > jp,
//            then rewrite the URL onto the local /api2 proxy.

const DEV_ID = import.meta.env.VITE_SCREENSCRAPER_DEV_ID
const DEV_PASSWORD = import.meta.env.VITE_SCREENSCRAPER_DEV_PASSWORD
const SOFT_NAME = import.meta.env.VITE_SCREENSCRAPER_SOFT_NAME || 'Panoply'

const REGION_ORDER = ['wor', 'us', 'eu', 'ss', 'jp']
const CACHE_PREFIX = 'cs-art-v1:'

function apiParams(extra) {
  return new URLSearchParams({
    devid: DEV_ID,
    devpassword: DEV_PASSWORD,
    softname: SOFT_NAME,
    output: 'json',
    ...extra,
  })
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MIN_REQUEST_GAP_MS = 250
let nextRequestAt = 0

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(id)
      reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

async function throttle(signal) {
  signal?.throwIfAborted()
  const delay = Math.max(0, nextRequestAt - performance.now())
  if (delay) await wait(delay, signal)
  nextRequestAt = performance.now() + MIN_REQUEST_GAP_MS
}

function retryDelay(res, attempt) {
  const retryAfter = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  return 500 * 2 ** attempt + Math.random() * 200
}

// ScreenScraper occasionally answers with 429/5xx during a cold-library scan.
// Keep concurrency at one (the caller's queue) and retry only transient errors.
export async function fetchWithRetry(url, { signal, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    await throttle(signal)
    const res = await fetch(url, { signal })
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= retries) return res
    await wait(retryDelay(res, attempt), signal)
  }
}

async function getJson(url, signal) {
  const res = await fetchWithRetry(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return JSON.parse(text) // API returns plain-text errors sometimes; let it throw
}

function toProxyUrl(rawUrl) {
  const u = new URL(rawUrl)
  // Media URLs need credentials appended when the API omits them.
  if (!u.searchParams.has('devid')) {
    u.searchParams.set('devid', DEV_ID)
    u.searchParams.set('devpassword', DEV_PASSWORD)
    u.searchParams.set('softname', SOFT_NAME)
  }
  const local = u.pathname + '?' + u.searchParams.toString()
  return local.startsWith('/api2/') ? local : '/api2' + local
}

export function cachedLabelUrl(systemId, title) {
  return localStorage.getItem(`${CACHE_PREFIX}${systemId}:${title}`)
}

export function clearArtCache() {
  const doomed = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(CACHE_PREFIX)) doomed.push(key)
  }
  doomed.forEach((k) => localStorage.removeItem(k))
  return doomed.length
}

export async function fetchLabelUrl(title, systemId = 14, searchTerm = title, { signal } = {}) {
  const cacheKey = `${CACHE_PREFIX}${systemId}:${title}`
  const cached = localStorage.getItem(cacheKey)
  if (cached) return cached

  // Phase 1 — search for the game id
  const search = await getJson(
    `/api2/jeuRecherche.php?${apiParams({ systemeid: String(systemId), recherche: searchTerm })}`,
    signal,
  )
  const rawJeux = search?.response?.jeux
  const list = Array.isArray(rawJeux) ? rawJeux : rawJeux?.jeu ? [].concat(rawJeux.jeu) : []
  const game = list[0]
  if (!game?.id) throw new Error(`No ScreenScraper match for "${title}"`)

  // Phase 2 — full media details
  const info = await getJson(
    `/api2/jeuInfos.php?${apiParams({ gameid: String(game.id) })}`,
    signal,
  )
  const medias = info?.response?.jeu?.medias || []

  // Phase 3 — the cropped cartridge label, best region first
  const stickers = medias.filter((m) => m.type === 'support-texture')
  let pick = null
  for (const region of REGION_ORDER) {
    pick = stickers.find((m) => m.region === region)
    if (pick) break
  }
  pick = pick || stickers[0]
  if (!pick?.url) throw new Error(`No support-texture media for "${title}"`)

  const proxied = toProxyUrl(pick.url)
  localStorage.setItem(cacheKey, proxied)
  return proxied
}
