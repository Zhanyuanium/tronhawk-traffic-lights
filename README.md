# TronHawk Traffic Lights

Move the target Electron app's self-drawn top-right window controls to
top-left macOS traffic-lights style buttons — or, when no original controls
are detected, show a host-hosted overlay instead.

Two paths, one visual language: **CSS move + repaint** when the original
buttons are detected (they stay in the DOM and keep their click behaviour —
only position and appearance change), else a **host overlay fallback**
(`electron.windowControls`, fully clickable). The plugin is fully
sandbox-compliant: no DOM/Node/Electron direct access, no arbitrary page JS
bridge, no Electron private APIs.

## Install

```sh
bun install
```

This installs `@tronhawk/sdk` (types + testing helpers, `^0.2.0` from
npmjs) plus the `@tronhawk/cli` devDependency (`^0.1.1` from npmjs, the
`tronhawk` binary), `typescript`, and `@types/bun`. No monorepo checkout is
required.

## Build, validate, pack (standalone toolchain)

The `@tronhawk/cli` devDependency (the `tronhawk` binary) drives the
toolchain. Authoritative checks always run in the same-version Rust engine
(`tronhawk-pack`); a passing `build`/`test` never substitutes for
`validate`:

```sh
bun run build          # tronhawk build .: bundle src/ entries to dist/ (single-file CommonJS)
bun run typecheck      # tsc --noEmit over src/ (checks .js via allowJs/checkJs)
bun test               # renderer smoke test against @tronhawk/sdk mocks (no host)
tronhawk validate .    # authoritative dir check (writes nothing)
tronhawk test . --sandbox  # QuickJS contract harness (same loading convention as the host)
bun run pack           # tronhawk pack . traffic-lights.thx: build -> staging -> Rust pack
tronhawk inspect traffic-lights.thx   # passthrough to the Rust engine
```

The CLI needs the native engine (same-version `tronhawk-pack`): set
`TRONHAWK_PACK_BIN` to the engine binary, e.g.

```sh
TRONHAWK_PACK_BIN=<tronhawk-repo>/target/release/tronhawk-pack.exe tronhawk validate .
```

(build it with `cargo build -p tronhawk-package --release` from a TronHawk
checkout, or download the asset matching your OS/arch from the TronHawk
GitHub Release). The CLI's `tronhawk.engineVersion` must exactly match
`tronhawk-pack --version`; a missing binary, digest mismatch, or version
mismatch hard-fails with install guidance — there is no TypeScript fallback
packer. Exit codes are a stable contract: 0 success, 1 authoritative
rejection (the message on stderr names the cause), 2 CLI usage error.

`tronhawk build` bundles the `src/` entry to `dist/` (the manifest keeps
`entry.renderer: "src/renderer.js"`; that CommonJS file is the single source,
typed inline with JSDoc and checked by `tsc --noEmit` via allowJs/checkJs).
`tronhawk pack` then stages
`manifest.json` + `dist/*.js` + `style.css` and runs a single authoritative
Rust `pack` (temp file + same-crate round-trip + atomic rename inside Rust),
so the packed manifest points at the built artifact `dist/renderer.js`.
`dist/` and `*.thx` are git-ignored.

Alternative (inside a TronHawk monorepo checkout, from the repo root):

```sh
cargo run -p tronhawk-package --bin tronhawk-pack -- validate <path-to-plugin>
cargo run -p tronhawk-package --bin tronhawk-pack -- pack <path-to-plugin> traffic-lights.thx
```

Then load `traffic-lights.thx` in the TronHawk Manager.

## Permissions (minimal)

- `renderer.css` — inject `style.css` (static CSS data via
  `webContents.insertCSS`) plus, when enabled, one short-lived decorative
  fallback rule.
- `renderer.dom` — snapshot `query` probe for the window-control group
  (diagnostics + fallback detection), plus a short-lived `observe`
  subscription only while a fallback is active. The observer
  disconnects as soon as real controls appear or on deactivate; snapshots
  lag live DOM by up to one poll interval (~500ms).
- `renderer.script` — execution-gate permission only: Core keeps
  `plugin.renderer` in the execution plan only when grants include
  `renderer.script` (or `runtime.unsafe`); the renderer makes no script call.
- `electron.windowControls` — host-hosted functional overlay
  (`ctx.windowControls.mount` / `unmount`, fixed-style traffic lights bound
  to the current window: minimize / toggle-maximize / close). Only used
  when no original controls are detected; never shown together with the
  decorative fallback.

## Unified styling

Single lamp skin (D1): d=14, pitch 24, cell 24x24, inset 5, gap 10, hover ×/–/+ glyphs, `#0a84ff` focus outline — no alternate skins.

Both paths share one visual language — 14px vector lights (DIP/CSS px; 28 physical
at DPR=2), pitch 24 (gap 10, 24x24 cells, inset 5), hover ×/–/+ vector glyphs
(14-grid, centered, hover-only, aria-hidden), `#0a84ff` focus outline: the host
overlay (transparent 24x24 hit cells in a 72xH view at (m+L, 0) where
m=(H-24)/2, default
(3,0,72,30), m=(H-24)/2, centered 14px inline SVGs, glyph shown on hover only)
and the relocated DOM buttons (repainted in place with centered SVG-background
glyphs on hover, still the app's own clickable controls). The
only difference is the control source. The decorative fallback keeps no
hover glyphs. Overlay pitch is fixed 24 (H only changes the view height and m);
relocated-DOM pitch is likewise fixed (size 14 + gap 10 = 24) — customize it
via the `:root` variable overrides below, not via manifest config.
Overlay tooltips come from a host-side en/zh table selected by the app locale
(`zh` prefix → Chinese), overridable per action via the `tooltip-*` configs
(empty = language default).

## Manifest (must satisfy the host schema)

```json
{
  "id": "com.tronhawk.traffic-lights",
  "name": "Traffic Lights",
  "version": "0.1.0",
  "author": "TronHawk Contributors",
  "tronhawk": "^0.1",
  "entry": { "css": "style.css", "renderer": "src/renderer.js" },
  "permissions": ["renderer.css", "renderer.dom", "renderer.script", "electron.windowControls"]
}
```

Notes: no top-level `description` key (the host manifest schema is
`deny_unknown_fields`); `entry.renderer` must be CommonJS
(`module.exports = { activate, deactivate }`) because the QuickJS sandbox
runs `vm.evalCode` — `src/renderer.js` is the single source (CommonJS,
JSDoc-typed, checked by `tsc --noEmit`).

## Config

Set in the Manager settings form (defaults from `manifest.json`):

| Key | Type | Default | Meaning |
| --- | ---- | ------- | ------- |
| `overlay-left-offset` | number | 0 | Overlay left adjustment L in CSS px/DIP, clamped 0-256 (host overlay geometry; view origin x = m+L where m=(H-24)/2) |
| `overlay-region-height` | number | 30 | Overlay region height H in CSS px/DIP, clamped 30-64 (host overlay geometry; view is 72×H, cells 24×24 at m=(H-24)/2) |
| `tooltip-close` | string | "" | Close tooltip override (empty = language default) |
| `tooltip-minimize` | string | "" | Minimize tooltip override (empty = language default) |
| `tooltip-maximize` | string | "" | Maximize tooltip override (empty = language default) |
| `tooltip-restore` | string | "" | Restore tooltip override (empty = language default) |
| `decorative-fallback-lights` | boolean | true | Show decorative fallback lights when no window controls are detected (decorative, not clickable) |
| `host-overlay-fallback` | boolean | true | Prefer the host overlay when no window controls are detected (functional host overlay, clickable) |

Host overlay geometry is declarative and restricted: the host reads only
`overlay-region-height` (H) and `overlay-left-offset` (L) from the plan config snapshot (manifest
defaults overlaid with stored values). All values are DIP/CSS px — the host never
converts pixels, reads `devicePixelRatio`/`scaleFactor`, or measures the
display, and there is no automatic display adaptation (physical pixels are never
taken as CSS px: 14 CSS = 28 physical at DPR=2). Sole table: d=14, p=24, cell
24×24, inset 5, gap 10, H=30 (30..64), m=(H-24)/2, default bounds (3,0,72,30). Visual
lights are a constant 14px; a plan revision with different values destroys the
old view and rebuilds, and co-owners with conflicting geometries fail closed on
`mount()` (which takes no arguments and performs no DOM measurement).
Custom overlay geometry needs the matching host update that reads the new
key names; until then the host falls back to its own defaults (H=30, L=0),
so the overlay still shows with default geometry.

DOM-path geometry is fixed (d=14, pitch 24, gap 10, 24x24 cells, inset 5);
customize it by overriding the CSS variables directly (`size` = lamp
diameter, `gap` = adjacent-lamp visual edge spacing, `left`/`top` = visual
lamp anchor; hit cells stay adjacent with container gap 0):

```css
:root {
  --th-traffic-size: 14px;
  --th-traffic-gap: 10px;
  --th-traffic-left: 12px;
  --th-traffic-top: 12px;
  /* derived, do not override: --th-traffic-cell-size (size+gap), --th-traffic-inset (gap/2) */
}
```

## Compatibility limits

- CSS move path: original button functions are preserved, but the
  mapping of close/minimize/maximize relies on `aria-label`/`title` semantics
  first and positional fallback (`[min, max, close]` → `[close, min, max]`)
  second. Unusual orders may need a custom rule.
- Covers generic Electron control groups (`.window-controls*`,
  `.window-control`, `[winButtons]`, `[p-titlebar__controls]` /
  `[titlebar__controls]`, `.caption-buttons` / `.captionButtons`,
  `.frameless-controls` / `.header-controls`) plus native macOS traffic-light groups. Detection
  uses a single `query` for that group; unknown self-drawn structures that
  match none of these selectors fall back to the host overlay below
  instead of moving anything.
- Decorative fallback (default on, `decorative-fallback-lights`): when no
  real control group is detected, the renderer inserts a single temporary
  `html::before` trio (`pointer-events: none`, reusing
  `--th-traffic-size` / `--th-traffic-gap` / `--th-traffic-left` /
  `--th-traffic-top`, hidden under `forced-colors`). The decorative
  fallback lights are decorative and not clickable — they cannot control
  the window (no close/minimize/maximize). A short-lived `observe`
  subscription watches for late-appearing controls (polling delay up to
  ~500ms) and removes the fallback as soon as they show up. The single
  `html::before` may conflict with apps or user styles that also use
  `html::before`; set `decorative-fallback-lights` to `false` if that
  happens.
- Host overlay fallback (default on, `host-overlay-fallback`): when no
  real control group is detected, the renderer first asks the host to mount
  its functional overlay (`ctx.windowControls.mount`, requires the
  `electron.windowControls` permission). The overlay is host-hosted with a
  fixed style and fully clickable (minimize / toggle-maximize / close the
  current window). Downgrade order is strict: real controls (CSS move, no
  JS fallback) → host overlay → decorative lights (not
  clickable) → nothing. The overlay and the decorative lights are never
  shown together: a successful `mount()` skips the decorative insert, a
  rejected `mount()` (or a host without the API) falls back to the
  decorative tier, and late-appearing real controls unmount the overlay
  (then the CSS move path takes over). `deactivate` always disconnects the
  observer first, then unmounts the overlay, then removes the decorative
  CSS — each step independent, never rejecting. Set
  `host-overlay-fallback` to `false` to skip the overlay and go
  straight to the decorative tier.
- In-container strategy: a cluster already inside the titlebar container prefers the in-container first child (`.titlebar .titlebar-button-container.mod-right` with `position: static`, `order: -1`, `align-self: center`, after the fixed rule). Transition: driven by the conclusion after the host `getTitlebar` API goes live.
- Typora (reserved): `w-min`/`w-max`/`w-restore`/`w-close` map red/yellow/green, `w-unpin` hidden by default; no other hiding until real controls are verified on device.
- Titlebar keeps `-webkit-app-region: drag`; buttons use `no-drag` so they
  stay clickable. Hover shows `×/–/+` glyphs; `focus-visible` keeps an
  accessible outline; light/dark schemes are adapted.

## Typecheck

```sh
bun install && bun run typecheck
```

(Part of the standalone toolchain above: `build` / `typecheck` / `test` /
`validate` / `pack` all run outside any monorepo checkout.)
