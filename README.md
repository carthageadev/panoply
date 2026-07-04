# Cartridge Studio

A retro game launcher for the web — a 3D N64 cartridge carousel with real
label art pulled live from ScreenScraper.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Controls

| Input | Action |
| --- | --- |
| ← / → (or click a side cartridge) | Browse games |
| Enter / A (or click the center cartridge) | Insert cartridge |
| Y | Settings |
| B | Apps |
| X | Inspect current game |
| L / R | Switch platform |
| Esc | Close any panel |

## How it works

- **3D model:** `public/new-n64cart.glb` — the `model_2` mesh gets the plastic
  shell textures, the `boxart` mesh gets the game's label art (see
  `3d model and api spec.md`).
- **Label art:** fetched from ScreenScraper (`jeuRecherche` → `jeuInfos` →
  `support-texture` media, region priority wor > us > eu > ss > jp), proxied
  through Vite's `/api2` proxy to avoid CORS, and cached in `localStorage`.
  Settings → Platforms → **Scan** clears the cache and refetches.
- **Keys:** ScreenScraper credentials live in `.env` (`VITE_SCREENSCRAPER_*`).
- Games list lives in `src/data/games.js` — add titles there and Scan.
