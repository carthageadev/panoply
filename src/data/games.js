// Default library. Cover/label art is fetched live from ScreenScraper
// and cached in localStorage, so titles just need to be searchable names.
export const PLATFORMS = [
  {
    id: 'n64',
    name: 'Nintendo 64',
    systemId: 14, // ScreenScraper system id (strict N64 filter)
    games: [
      { title: 'Pokemon Stadium' },
      { title: 'Pokemon Snap' },
      { title: 'Mario Party' },
      { title: 'Castlevania' },
      { title: 'Bomberman 64' },
      { title: 'Star Wars: Episode I - Battle for Naboo', search: 'Battle for Naboo' },
      { title: 'Super Mario 64' },
      { title: 'Mario Kart 64' },
      { title: 'The Legend of Zelda: Ocarina of Time', search: 'Ocarina of Time' },
      { title: 'Star Fox 64' },
      { title: 'GoldenEye 007' },
      { title: 'Banjo-Kazooie' },
    ],
  },
  // Second console for testing platform switching — reuses the N64 cartridge
  // model/assets, just a different library.
  {
    id: 'n64x',
    name: 'Nintendo 64 EX',
    systemId: 14,
    games: [
      { title: 'Donkey Kong 64' },
      { title: 'Diddy Kong Racing' },
      { title: 'Kirby 64: The Crystal Shards', search: 'Kirby 64' },
      { title: 'Wave Race 64' },
      { title: 'F-Zero X' },
      { title: 'Paper Mario' },
      { title: "Yoshi's Story" },
      { title: 'Star Wars: Rogue Squadron', search: 'Rogue Squadron' },
    ],
  },
]
