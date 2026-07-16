const SHELL_CACHE = 'panoply-shell-v1'
const RUNTIME_CACHE = 'panoply-runtime-v1'
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/art.svg',
  '/image.png',
  '/new-n64cart.glb',
  '/newbase.jpg',
  '/newbase_Normal.tga.png',
  '/newbase_Roughness.tga.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => ![SHELL_CACHE, RUNTIME_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  // A scan must be online. Never cache the credential-bearing JSON requests.
  if (url.pathname.startsWith('/api2/') && url.pathname.endsWith('.php')) return

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'error') return response
        const copy = response.clone()
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy))
        return response
      })
    }),
  )
})
