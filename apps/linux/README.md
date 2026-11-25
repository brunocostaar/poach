# Poach for Linux (preview)

A Tauri client that captures through xdg-desktop-portal and hands briefs to the
same MCP connector as the Mac app. It runs `@poach/core` with the system Node.js,
so analysis, briefs and `poach_read_moment` behave the same on both platforms.

## Status

| Feature | Linux |
| --- | --- |
| Record a screen or window (PipeWire → GStreamer, H.264 MP4) | ✅ |
| Recording controls (timer and Stop) that stay out of the video | ✅ windows always; screens with the GNOME extension |
| Screenshot (Screenshot portal) | ✅ |
| Open an existing image or video | ✅ |
| Keyframes, palette, timing (`@poach/core`) | ✅ |
| Timestamped notes and instructions | ✅ |
| Handoff to Claude Code / Codex via MCP | ✅ |
| Record a free-form area | ⏳ portals only offer screens and windows; crop afterwards |
| Pointer trace | ⏳ planned via `CursorMode::METADATA` (positions only; Wayland does not expose button state) |
| Global capture shortcut | ⏳ planned via the GlobalShortcuts portal |
| Font matching, favorites, Chrome companion, palette overrides | ⏳ |
| Excluding Poach's own window from recordings | ✅ Poach hides while capturing |

## Requirements (Fedora)

```sh
sudo dnf install webkit2gtk4.1-devel libsoup3-devel javascriptcoregtk4.1-devel \
  openssl-devel librsvg2-devel gcc pkgconf-pkg-config \
  pipewire-gstreamer gstreamer1-plugin-openh264 gstreamer1-plugins-bad-free \
  ffmpeg-free nodejs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Debian/Ubuntu: `libwebkit2gtk-4.1-dev build-essential libssl-dev librsvg2-dev
gstreamer1.0-pipewire gstreamer1.0-plugins-bad ffmpeg nodejs`.

## GNOME extension

Wayland cannot exclude a window from a capture. On GNOME, Poach records screens
through Mutter's `RecordArea`, which paints the stage again off-screen, and the
**Poach Capture** extension skips the recording controls in those paints. The
controls stay visible on your monitor and never reach the video. The extension
also keeps the controls above other windows and tells Poach which monitor to
record (the one under the pointer).

```sh
apps/linux/gnome-extension/install.sh   # then log out and back in
```

Without the extension, screen recordings use the ScreenCast portal and the
controls may appear in the video. Window recordings never include them.

## Run

From the repository root:

```sh
pnpm install
pnpm build                     # builds @poach/core, the MCP server and this UI
pnpm --filter @poach/linux app:dev
```

`pnpm --filter @poach/linux app:build` produces `.deb`, `.rpm` and AppImage
bundles. The bundles still look for the analysis engine in the checkout; set
`POACH_CORE_ENTRY` to another `packages/core/dist/index.js` and `POACH_NODE` to
another Node binary if needed.

## Connect your assistant

```sh
claude mcp add poach -- node "$PWD/packages/mcp-server/dist/index.js"
# or
codex mcp add poach -- node "$PWD/packages/mcp-server/dist/index.js"
```

Open a new session; Poach shows **Connector active** once the server is running.

## Data

Everything stays in `$XDG_CACHE_HOME/poach` (default `~/.cache/poach`, mode 700):
recordings and screenshots in `captures/`, keyframes in `frames/`, briefs in
`active-brief.json` and `briefs/`. Briefs expire after 24 hours, as on macOS.
