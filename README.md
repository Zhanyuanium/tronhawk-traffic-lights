# TronHawk Traffic Lights

Move the target Electron app's self-drawn top-right window controls to
top-left macOS traffic-lights style buttons.

Strategy is **CSS move + repaint**: the original buttons stay in the DOM and
keep their click behaviour — only their position and appearance change.
The plugin is fully sandbox-compliant: no DOM/Node/Electron direct access, no
arbitrary page JS bridge, no Electron private APIs.

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

`tronhawk build` bundles the `src/` entries to `dist/` (the source
`manifest.json` keeps `entry.renderer: "src/renderer.js"` so the build can
find the TypeScript source; `src/renderer.ts` is the type source,
`src/renderer.js` the CommonJS runtime file). `tronhawk pack` then stages
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
  `webContents.insertCSS`) plus one small runtime padding patch and, when
  enabled, one short-lived decorative fallback rule.
- `renderer.dom` — snapshot `query` probe for the window-control group
  (diagnostics + fallback detection), plus a short-lived `observe`
  subscription only while the decorative fallback is active. The observer
  disconnects as soon as real controls appear or on deactivate; snapshots
  lag live DOM by up to one poll interval (~500ms).
- `renderer.script` — one title-preserving `ctx.script.setDocumentTitle`
  call (reads the `<title>` snapshot and writes it back, so the visible
  title never changes). Required because Core only keeps `plugin.renderer`
  in the execution plan when grants include `renderer.script` (or
  `runtime.unsafe`); without it the renderer never runs.

## Manifest (must satisfy the host schema)

```json
{
  "id": "com.tronhawk.traffic-lights",
  "name": "Traffic Lights",
  "version": "0.1.0",
  "author": "TronHawk Contributors",
  "tronhawk": "^0.1",
  "entry": { "css": "style.css", "renderer": "src/renderer.js" },
  "permissions": ["renderer.css", "renderer.dom", "renderer.script"]
}
```

Notes: no top-level `description` key (the host manifest schema is
`deny_unknown_fields`); `entry.renderer` must be CommonJS
(`module.exports = { activate, deactivate }`) because the QuickJS sandbox
runs `vm.evalCode` — `src/renderer.js` is the runtime entry, `src/renderer.ts`
is the type source.

## Config

Set in the Manager settings form (defaults from `manifest.json`):

| Key | Type | Default | Meaning |
| --- | ---- | ------- | ------- |
| `button-size` | number | 12 | Traffic light button diameter (px, maps to `--th-traffic-size`) |
| `traffic-gap` | number | 8 | Gap between buttons (px, maps to `--th-traffic-gap`) |
| `left-offset` | number | 12 | Left offset of the group (px, maps to `--th-traffic-left`) |
| `decorative-fallback-lights` | boolean | true | Show decorative fallback lights when no window controls are detected (decorative, not clickable) |

You can also override the CSS variables directly:

```css
:root {
  --th-traffic-size: 12px;
  --th-traffic-gap: 8px;
  --th-traffic-left: 12px;
  --th-traffic-top: 12px;
}
```

## Compatibility limits

- Pure CSS relocation: original button functions are preserved, but the
  mapping of close/minimize/maximize relies on `aria-label`/`title` semantics
  first and positional fallback (`[min, max, close]` → `[close, min, max]`)
  second. Unusual orders may need a custom rule.
- Covers generic Electron control groups (`.window-controls*`,
  `.window-control`, `[winButtons]`, `[p-titlebar__controls]` /
  `[titlebar__controls]`, `.caption-buttons` / `.captionButtons`,
  `.frameless-controls`) plus native macOS traffic-light groups. Detection
  uses a single `query` for that group; unknown self-drawn structures that
  match none of these selectors fall back to the decorative lights below
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
- If the app already renders native macOS traffic lights, the plugin leaves
  them alone to avoid duplicates.
- Titlebar keeps `-webkit-app-region: drag`; buttons use `no-drag` so they
  stay clickable. Hover shows `×/–/+` glyphs; `focus-visible` keeps an
  accessible outline; light/dark schemes are adapted.

## Typecheck

```sh
bun install && bun run typecheck
```

(Part of the standalone toolchain above: `build` / `typecheck` / `test` /
`validate` / `pack` all run outside any monorepo checkout.)
