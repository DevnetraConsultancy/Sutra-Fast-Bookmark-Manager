/*! Sutra © 2025-2026 Devnetra Consultancy. All rights reserved. Proprietary software; copying, modifying or redistributing without written permission is prohibited. See LICENSE. */
// Runs before first paint so the saved theme, accent, icon size and wallpaper appear at
// once instead of flashing the defaults. dashboard.js writes these hints.
try {
  const boot = JSON.parse(localStorage.getItem("sutra_boot") || "{}");
  if (boot.theme === "light") document.body.classList.add("light-theme");
  if (boot.accent) document.body.dataset.accent = boot.accent;
  if (boot.iconSize) document.documentElement.style.setProperty("--icon-size", `${boot.iconSize}px`);

  // In "every new tab" mode this load is about to switch wallpaper, so show that one now.
  const upcoming = boot.upcoming && Date.now() >= boot.upcoming.dueAt ? boot.upcoming : null;
  const pick = upcoming || boot.wallpaper;
  const layer = document.getElementById("wallpaper");
  const show = url => {
    layer.style.backgroundImage = `url("${url}")`;
    layer.classList.add("ready");
  };
  if (pick && pick.path) {
    window.__sutraWallpaper = caches.open("sutra-wallpapers")
      .then(cache => cache.match(pick.path))
      .then(response => response ? response.blob() : null)
      .then(blob => {
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        show(url);
        return { token: pick.token, url };
      })
      .catch(() => null);
  } else {
    show("default-wallpaper.webp");
    window.__sutraWallpaper = Promise.resolve({ token: "default", url: "default-wallpaper.webp" });
  }
} catch {}
