import { useState } from 'react'
import { clearArtCache } from './lib/screenscraper.js'
import { clearCachedArt } from './lib/artCache.js'

const SECTIONS = [
  { id: 'platforms', icon: '▤', label: 'Platforms' },
  { id: 'achievements', icon: '★', label: 'Achievements' },
  { id: 'appearance', icon: '✎', label: 'Appearance' },
  { id: 'feedback', icon: '✉', label: 'Feedback' },
  { id: 'about', icon: 'ℹ', label: 'About' },
]

export default function SettingsPanel({
  platform,
  artMap,
  theme,
  setTheme,
  uiScale,
  setUiScale,
  sceneZoom,
  setSceneZoom,
  showToast,
  onRescan,
  closing,
  onClose,
}) {
  const [section, setSection] = useState('platforms')
  const [feedback, setFeedback] = useState('')

  const artCount = platform.games.filter((g) => artMap[`${platform.id}:${g.title}`]).length

  const scan = async () => {
    const cleared = clearArtCache() // localStorage URL cache
    await clearCachedArt() // IndexedDB image blobs
    onRescan()
    showToast(`Rescanning label art (${cleared} cached entries cleared)…`)
  }

  return (
    <div className={`overlay${closing ? ' closing' : ''}`}>
      <div className="settings-wrap">
        <div className="card settings-card">
          <aside className="settings-sidebar">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`side-btn ${section === s.id ? 'active' : ''}`}
                onClick={() => setSection(s.id)}
              >
                <span className="side-icon">{s.icon}</span>
                {s.label}
              </button>
            ))}
            <button
              className="side-btn donate"
              onClick={() => showToast('Thank you for the thought! ♥')}
            >
              <span className="side-icon">♥</span>Donate
            </button>
          </aside>

          <section className="settings-content">
            <div key={section} className="settings-section">
            {section === 'platforms' && (
              <>
                <div className="platform-row">
                  <div className="platform-row-title">
                    {platform.id.toUpperCase()} — {platform.name}
                  </div>
                  <button className="pill pill-blue small" onClick={scan}>
                    ⟳ Scan
                  </button>
                  <button
                    className="pill pill-yellow small"
                    onClick={() => showToast('Platform editor — coming soon!')}
                  >
                    ✎ Edit
                  </button>
                </div>
                <p className="muted small-text">
                  {platform.games.length} games · {artCount} labels from ScreenScraper
                </p>
                <ul className="game-list">
                  {platform.games.map((g) => (
                    <li key={g.title}>
                      <span className={`dot ${artMap[`${platform.id}:${g.title}`] ? 'ok' : ''}`} />
                      {g.title}
                    </li>
                  ))}
                </ul>
                <button
                  className="add-platform"
                  onClick={() => showToast('Add Platform — coming soon!')}
                >
                  Add Platform
                </button>
              </>
            )}

            {section === 'achievements' && (
              <div className="placeholder-panel">
                <h3>★ Achievements</h3>
                <p className="muted">
                  No achievements yet. RetroAchievements integration is on the roadmap!
                </p>
              </div>
            )}

            {section === 'appearance' && (
              <div className="placeholder-panel">
                <h3>✎ Appearance</h3>
                <p className="muted">Pick a theme for the launcher shell.</p>
                <div className="theme-row">
                  <button
                    className={`pill pill-white ${theme === 'light' ? 'selected' : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    Light
                  </button>
                  <button
                    className={`pill pill-dark ${theme === 'dark' ? 'selected' : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    Dark
                  </button>
                </div>

                <p className="muted" style={{ marginTop: '20rem' }}>
                  Scale the interface and the 3D scene independently.
                </p>
                <div className="scale-row">
                  <label htmlFor="ui-scale">UI Scale</label>
                  <input
                    id="ui-scale"
                    type="range"
                    min="0.7"
                    max="1.4"
                    step="0.05"
                    value={uiScale}
                    onChange={(e) => setUiScale(Number(e.target.value))}
                  />
                  <span className="scale-value">{Math.round(uiScale * 100)}%</span>
                </div>
                <div className="scale-row">
                  <label htmlFor="scene-zoom">3D Scale</label>
                  <input
                    id="scene-zoom"
                    type="range"
                    min="0.6"
                    max="1.5"
                    step="0.05"
                    value={sceneZoom}
                    onChange={(e) => setSceneZoom(Number(e.target.value))}
                  />
                  <span className="scale-value">{Math.round(sceneZoom * 100)}%</span>
                </div>
                <div className="reset-row">
                  <button
                    className="pill pill-grey"
                    onClick={() => {
                      setUiScale(1)
                      setSceneZoom(1)
                      showToast('Scales reset to defaults')
                    }}
                  >
                    ⟲ Reset to defaults
                  </button>
                </div>
              </div>
            )}

            {section === 'feedback' && (
              <div className="placeholder-panel">
                <h3>✉ Feedback</h3>
                <textarea
                  className="feedback-box"
                  rows={5}
                  placeholder="Tell us what you think…"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                />
                <button
                  className="pill pill-green"
                  onClick={() => {
                    setFeedback('')
                    showToast('Thanks for the feedback! ♥')
                  }}
                >
                  Send
                </button>
              </div>
            )}

            {section === 'about' && (
              <div className="placeholder-panel">
                <h3>ℹ Cartridge Studio</h3>
                <p className="muted">v0.1.0 — a love letter to cartridge-era consoles.</p>
                <p className="muted small-text">
                  3D cartridge shell rendered live · label art via ScreenScraper.fr
                </p>
              </div>
            )}
            </div>
          </section>
        </div>

        <div className="settings-footer">
          <button className="pill pill-red" onClick={onClose}>
            <span className="glyph">Ⓑ</span>Close
          </button>
          <button
            className="pill pill-purple"
            onClick={() => window.open('https://discord.com', '_blank')}
          >
            Discord
          </button>
        </div>
      </div>
    </div>
  )
}
