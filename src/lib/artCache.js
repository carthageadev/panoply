// IndexedDB blob cache for cartridge label art. Origin-scoped and persistent:
// once an image has been downloaded from ScreenScraper it is stored here,
// keyed per game, and every later boot loads it locally — zero network.
const DB_NAME = 'cartridge-studio'
const STORE = 'label-art'

let dbPromise = null

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const db = () => (dbPromise ??= openDb())

export async function getCachedArt(key) {
  try {
    const d = await db()
    return await new Promise((resolve, reject) => {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null // cache is best-effort; fall back to the network
  }
}

export async function putCachedArt(key, blob) {
  try {
    const d = await db()
    await new Promise((resolve, reject) => {
      const req = d.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key)
      req.onsuccess = resolve
      req.onerror = () => reject(req.error)
    })
  } catch {
    /* best-effort */
  }
}

export async function clearCachedArt() {
  try {
    const d = await db()
    await new Promise((resolve, reject) => {
      const req = d.transaction(STORE, 'readwrite').objectStore(STORE).clear()
      req.onsuccess = resolve
      req.onerror = () => reject(req.error)
    })
  } catch {
    /* best-effort */
  }
}
