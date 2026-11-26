# Contributing to Sutra

Thank you for helping make Sutra better. Bug reports, ideas and pull requests are all welcome.

## Run it locally

1. Fork and clone the repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the repository folder.
3. After editing, press the reload icon on Sutra's card and open a new tab.

There is no build step and no dependency to install.

## Ground rules

- **Plain web platform.** HTML, CSS and JavaScript only; no frameworks or packages.
- **Privacy first.** No analytics, no tracking, no remote code. A new network request needs a clear reason, must be listed in the README and in `privacy-policy.html`, and should be optional where possible.
- **Fast by default.** Keep work off the first paint: anything network-bound waits until the launchpad is drawn.
- **Quiet console.** Expected failures (offline, a missing file, a denied permission) are shown to the user in the page and logged with `console.info`, never `console.error`.
- **Accessible.** Buttons and inputs need labels, and everything works from the keyboard.

## Before you open a pull request

- Test in Chrome with an empty library and with a large one (a few hundred sites).
- Try it offline, in light and dark themes, and with icons-only on.
- Check that `chrome://extensions` shows no errors for Sutra.
- Bump `version` in `manifest.json` and add a line to `CHANGELOG.md` if users will notice the change.

## Commit messages

A short summary line in the imperative ("Add quote timer"), then a blank line and the reason, if it is not obvious.

By contributing you agree your work is released under the [MIT License](LICENSE.txt), and that you follow our [Code of Conduct](CODE_OF_CONDUCT.md).
