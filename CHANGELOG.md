# Changelog

All notable changes to Sutra. Dates are in YYYY-MM-DD.

## 2.23.0 — 2026-11-26
**Speed**
- The last launchpad is painted the instant a tab opens, then refreshed from storage; unchanged tiles are kept, so nothing reloads twice.
- Settings, CSS variables and the clock touch the page only when something changed. With 300 sites, tiles appear about 40% sooner.

**Reliability**
- Offline, weather and quotes wait quietly and refresh when the connection returns.
- Expected problems (no network, a missing backup folder, an unreadable image) are explained in the page, not reported as extension errors.
- Icons that fail early fall back to the lettered tile.

## 2.22.0 — 2026-11-26
- **Quotes**: a line from a scientist, writer or thinker at the bottom of the screen, from the free Quotable API. New on every tab, every 5, 10 or 30 minutes, hourly or daily.

## 2.21.0 — 2026-11-26
- **Frequent sites** row, **number keys 1–9**, **clock and greeting**, **search engine** choice, **density** and **group columns**.
- New **Launchpad** section in Settings.

## 2.20.0 — 2026-11-26
- **Show site names** switch for an icons-only grid.
- Groups management folds into a dropdown; a more compact Settings panel.
- Released under the **MIT License**.

## 2.19.1 — 2026-11-25
- Online photos ask for permission when turned on; network hiccups no longer appear as extension errors.

## 2.19.0 — 2026-11-25
- **Open sites in**: same tab or new tab.
- Site icons are probed in stages and missing ones rechecked every 6 hours, ending repeated "Failed to load resource" errors.
- Fixes for permission errors, unhandled backup and export failures, and boot hints written too early.

## 2.18.0
- First public release.
