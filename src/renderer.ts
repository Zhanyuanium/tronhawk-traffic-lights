import type { PluginModule, RendererContext } from "@tronhawk/sdk";

/**
 * Runtime-injected patch id returned by `ctx.css.insert`.
 * Kept at module level so `deactivate` can clean it up.
 */
let patchCssId: string | null = null;

/**
 * Decorative fallback CSS id (single `html::before`, not clickable).
 * Null when the fallback is disabled, not needed, or already removed.
 */
let fallbackCssId: string | null = null;

/** Disconnect function for the short-lived controls observer. */
let controlObserverDisconnect: (() => void) | null = null;

/** Set by the observer callback when real controls appear. */
let controlsObserved = false;

/**
 * True while the host-hosted functional overlay is mounted.
 * The overlay and the decorative fallback are never shown together.
 */
let overlayMounted = false;

/**
 * True while a `windowControls.mount()` is in flight. Cleared when it
 * settles, when the observer fires first, or on deactivate — so a late
 * mount success after cancellation unmounts instead of sticking around
 * next to real controls (or as residue after deactivate).
 */
let mountPending = false;

/**
 * Minimal host windowControls surface. `@tronhawk/sdk@0.2.0` has no
 * `windowControls` declaration, so we narrow locally instead of relying on
 * the SDK type. Never `any`: the runtime check in `getWindowControls`
 * verifies shape before any call.
 */
interface HostWindowControls {
  mount(): Promise<void>;
  unmount(): Promise<void>;
}

/** RendererContext with an optional host overlay (old hosts omit it). */
type RendererContextWithOverlay = RendererContext & {
  windowControls?: unknown;
};

/**
 * Return the host overlay API when present and well-formed, else null.
 * Must be called before every mount/unmount (never assume existence).
 */
function getWindowControls(ctx: RendererContext): HostWindowControls | null {
  const candidate = (ctx as RendererContextWithOverlay).windowControls;
  if (candidate === null || candidate === undefined) {
    return null;
  }
  if (typeof candidate !== "object") {
    return null;
  }
  const mount = (candidate as { mount?: unknown }).mount;
  const unmount = (candidate as { unmount?: unknown }).unmount;
  if (typeof mount !== "function" || typeof unmount !== "function") {
    return null;
  }
  return candidate as HostWindowControls;
}

/**
 * Cancel an in-flight `windowControls.mount()` by issuing a host `unmount()`
 * while still pending. The host treats unmount-during-pending as a cancel
 * (pending-mount cancel semantics), so the overlay never gets a window in
 * which to show next to real controls, and a mount that never settles still
 * gets cancelled promptly instead of lingering. Best-effort and never
 * rejects. No-op when no mount is pending. (The post-settle continuation
 * still re-checks and unmounts again if the host mounted anyway.)
 */
async function cancelPendingMount(ctx: RendererContext): Promise<void> {
  if (!mountPending) {
    return;
  }
  mountPending = false;
  const wc = getWindowControls(ctx);
  if (wc === null) {
    return;
  }
  try {
    await wc.unmount();
  } catch {
    ctx.logger.warn("[traffic-lights] windowControls unmount failed");
  }
}

/**
 * Real window-control groups only (single comma-separated selector).
 * Pure `.titlebar` containers are intentionally excluded: they always match
 * and would suppress the fallback even when no buttons exist. Only the
 * precise `.titlebar-button-container.mod-right` is moved for Obsidian: bare
 * `.titlebar-button.mod-*` buttons outside it must not suppress the overlay.
 * Discord moves `div[class*="winButtons" i]` only: a bare singular
 * `[class*="winButton" i]` outside that container is repainted by CSS but
 * must not suppress the overlay on its own (CSS D tier still repaints the
 * container's child buttons).
 */
const WINDOW_CONTROL_SELECTOR: string =
  ".window-controls,.window-controls-container,.window-control," +
  '[class*="window-controls" i],[class*="windowControls" i],' +
  '[class*="winButtons" i],' +
  '[class*="p-titlebar__controls" i],[class*="titlebar__controls" i],' +
  ".caption-buttons,.captionButtons,.frameless-controls,.header-controls," +
  ".traffic-lights,.mac-traffic-lights,.macos-traffic-lights,.titlebar-traffic-lights," +
  ".titlebar-button-container.mod-right";

/**
 * Decorative fallback: a single `html::before` trio rendered via
 * `background` + `box-shadow`. Fixed position reusing the `--th-traffic-*`
 * variables, `pointer-events: none`, never interactive (no hover/active /
 * focus / cursor states, no close/minimize/maximize glyphs), hidden under
 * forced-colors mode.
 */
const DECORATIVE_FALLBACK_CSS: string =
  'html::before{content:"";position:fixed;left:var(--th-traffic-left,12px);' +
  "top:var(--th-traffic-top,12px);width:var(--th-traffic-size,14px);" +
  "height:var(--th-traffic-size,14px);border-radius:50%;background:#ff5f57;" +
  "box-shadow:calc(var(--th-traffic-size,14px) + var(--th-traffic-gap,10px)) 0 0 #febc2e," +
  "calc((var(--th-traffic-size,14px) + var(--th-traffic-gap,10px)) * 2) 0 0 #28c840;" +
  "pointer-events:none;z-index:9999}" +
  "@media (forced-colors:active){html::before{display:none !important}}";

/** Remove the fallback CSS if present. Repeat-safe (second call is a no-op). */
async function removeFallbackCss(ctx: RendererContext): Promise<void> {
  const id = fallbackCssId;
  fallbackCssId = null;
  if (id !== null) {
    try {
      await ctx.css.remove(id);
    } catch {
      ctx.logger.warn("[traffic-lights] fallback CSS cleanup failed");
    }
  }
}

/** Disconnect the controls observer if present. Clears the ref before calling. */
function disconnectControlObserver(): void {
  const disconnect = controlObserverDisconnect;
  controlObserverDisconnect = null;
  if (disconnect !== null) {
    try {
      disconnect();
    } catch {
      // Synchronous host callback; ignore errors so deactivate never rejects.
    }
  }
}

/**
 * Unmount the functional overlay when mounted. Flag-gated so a fresh
 * activate/deactivate without a prior mount never touches the host.
 * Never rejects: failures only warn, state is always cleared.
 */
async function unmountOverlay(ctx: RendererContext): Promise<void> {
  if (!overlayMounted) {
    return;
  }
  overlayMounted = false;
  const wc = getWindowControls(ctx);
  if (wc === null) {
    return;
  }
  try {
    await wc.unmount();
  } catch {
    ctx.logger.warn("[traffic-lights] windowControls unmount failed");
  }
}

/**
 * Activate the plugin.
 *
 * Downgrade order on a full miss (no original controls):
 * real controls (CSS move, no JS fallback) -> functional host overlay
 * (`ctx.windowControls.mount`, clickable) -> decorative fallback
 * (`html::before`, pointer-events none, not clickable) -> nothing.
 * The overlay and the decorative fallback are never shown together.
 *
 * Sandbox contract: may return `undefined` synchronously or a `Promise`
 * (the runtime drains it). Must never use `console.*`, must only log via
 * `ctx.logger` with plain strings, and must never return a non-undefined
 * value from event callbacks (the `observe` callback below returns
 * `undefined` synchronously).
 */
export async function activate(ctx: RendererContext): Promise<void> {
  ctx.logger.info("[traffic-lights] activate: moving controls to top-left");
  controlsObserved = false;
  mountPending = false;
  // Best-effort cleanup of a stale overlay from a previous activate that
  // never saw its deactivate (no-op when clean, never rejects).
  await unmountOverlay(ctx);
  overlayMounted = false;

  let decorativeEnabled = true;
  let functionalEnabled = true;
  try {
    decorativeEnabled = ctx.config.get("decorative-fallback-lights") !== false;
    functionalEnabled = ctx.config.get("functional-fallback-controls") !== false;
  } catch {
    ctx.logger.warn("[traffic-lights] config read failed");
    decorativeEnabled = false;
    functionalEnabled = false;
  }

  let controlsFound = false;
  let queryFailed = false;
  try {
    const found = await ctx.dom.query(WINDOW_CONTROL_SELECTOR);
    if (found !== null) {
      controlsFound = true;
      ctx.logger.info("[traffic-lights] window controls found");
    }
  } catch {
    queryFailed = true;
    ctx.logger.warn("[traffic-lights] controls query failed");
  }

  if (controlsFound) {
    // Move path: original buttons stay functional via static CSS.
    // Ensure no functional overlay is left mounted so we never double-show.
    await unmountOverlay(ctx);
  } else if (!queryFailed) {
    // Full miss: register one short-lived observer for late-appearing
    // controls. It unmounts the overlay (if mounted) and removes the
    // decorative fallback, then disconnects. Registered only when a
    // fallback can actually show: decorative enabled, or functional
    // enabled with a host overlay present (old hosts get no observer).
    let observeRegistered = false;
    const overlayAvailable =
      functionalEnabled && getWindowControls(ctx) !== null;
    if (decorativeEnabled || overlayAvailable) {
      try {
        const disconnect = ctx.dom.observe(WINDOW_CONTROL_SELECTOR, (_node) => {
          controlsObserved = true;
          disconnectControlObserver();
          // Prompt cancel: issue a host unmount while the mount is still
          // pending (unmountOverlay below only covers the already-mounted
          // case, where its flag is set).
          void cancelPendingMount(ctx);
          void unmountOverlay(ctx);
          void removeFallbackCss(ctx);
          return undefined;
        });
        controlObserverDisconnect = disconnect;
        observeRegistered = true;
      } catch {
        ctx.logger.warn("[traffic-lights] controls observe failed");
        controlObserverDisconnect = null;
        observeRegistered = false;
      }
    }

    // Functional overlay first (clickable, host-hosted). Gated on the
    // observer: without late-controls detection a mounted overlay could
    // double-show with real controls, so fail closed (no mount) when the
    // observer is missing.
    let overlayActive = false;
    if (functionalEnabled && observeRegistered) {
      const wc = getWindowControls(ctx);
      if (wc !== null) {
        mountPending = true;
        try {
          await wc.mount();
          if (!mountPending || controlsObserved) {
            // Cancelled while pending (observer/deactivate already issued a
            // cancel unmount above); if the host mounted anyway, unmount
            // again so the final state stays single. Never mark active.
            mountPending = false;
            overlayMounted = true;
            await unmountOverlay(ctx);
            overlayActive = false;
          } else {
            mountPending = false;
            overlayMounted = true;
            overlayActive = true;
            ctx.logger.info("[traffic-lights] windowControls overlay mounted");
          }
        } catch {
          mountPending = false;
          ctx.logger.warn("[traffic-lights] windowControls mount failed");
          overlayMounted = false;
          overlayActive = false;
        }
      } else {
        ctx.logger.info("[traffic-lights] windowControls unavailable");
      }
    }

    if (!overlayActive) {
      // Decorative fallback (existing behavior): only when the overlay did
      // not take over, reusing the observer above. Fails closed when the
      // observer is missing or late controls already appeared.
      if (decorativeEnabled && observeRegistered && !controlsObserved) {
        try {
          fallbackCssId = await ctx.css.insert(DECORATIVE_FALLBACK_CSS);
        } catch {
          ctx.logger.warn("[traffic-lights] fallback CSS insert failed");
          fallbackCssId = null;
          disconnectControlObserver();
        }
        if (fallbackCssId !== null && controlsObserved) {
          await removeFallbackCss(ctx);
        }
      }
      // No fallback active (mount failed + decorative disabled, or a race
      // already resolved to real controls): do not leak the observer.
      if (!overlayMounted && fallbackCssId === null && !decorativeEnabled) {
        disconnectControlObserver();
      }
    }
  }

  // Keep the visible title unchanged while exercising `renderer.script`
  // (required so the `renderer.script` grant is actually used): read the
  // <title> snapshot and write it back. Skipped when absent so we never
  // blank the title on apps without one.
  try {
    const titleEl = await ctx.dom.query("title");
    const text = titleEl?.text;
    if (typeof text === "string" && text.length > 0) {
      try {
        ctx.script.setDocumentTitle(text.slice(0, 256));
      } catch {
        ctx.logger.warn("[traffic-lights] setDocumentTitle failed");
      }
    }
  } catch {
    ctx.logger.warn("[traffic-lights] title query failed");
  }

  // Small dynamic patch: reserve left padding so titles/tabs do not slide
  // under the relocated lights. Static repaint lives in style.css (data).
  // Obsidian (verified 1.13.7, mod-windows is-hidden-frameless): div.titlebar
  // (fixed strip) > div.titlebar-inner (flex, width:100%) > div.titlebar-text
  // (absolute, centered, hidden in this mode) plus
  // div.titlebar-button-container.mod-left (absolute left:0, back/forward are
  // display:none here) and .mod-right (absolute right:0, the moved cluster).
  // This patch reserves the titlebar subtree only (custom-frame mode, where
  // the opaque bar holds visible content). The visible top-left tab icons in
  // hidden-frameless mode live OUTSIDE .titlebar in
  // .workspace-tabs.mod-top-left-space .workspace-tab-header-container, which
  // style.css section 6 pads instead. The left container is absolute left:0
  // so it uses margin-left instead of padding-left.
  try {
    patchCssId = await ctx.css.insert(
      ".titlebar .window-title{padding-left:var(--th-traffic-reserved,76px)}" +
        ".titlebar{padding-left:var(--th-traffic-reserved,76px)}" +
        ".titlebar-inner{padding-left:var(--th-traffic-reserved,76px)}" +
        ".titlebar-text{padding-left:var(--th-traffic-reserved,76px)}" +
        ".titlebar-button-container.mod-left{margin-left:var(--th-traffic-reserved,76px)}",
    );
  } catch {
    ctx.logger.warn("[traffic-lights] dynamic CSS patch failed");
    patchCssId = null;
  }
}

/**
 * Deactivate the plugin: disconnect the observer first, then cancel any
 * pending mount and unmount the overlay, then clean up the fallback and
 * padding patches independently (one failure never skips the other).
 * Clears all module state and never rejects.
 */
export async function deactivate(ctx: RendererContext): Promise<void> {
  try {
    try {
      disconnectControlObserver();
    } catch {
      ctx.logger.warn("[traffic-lights] observer disconnect failed");
    }
    try {
      // Cancel any in-flight mount first (issues a host unmount while
      // pending) so a pending mount never sticks around after deactivate;
      // then clean up an already-mounted overlay.
      await cancelPendingMount(ctx);
    } catch {
      ctx.logger.warn("[traffic-lights] windowControls unmount failed");
    }
    try {
      await unmountOverlay(ctx);
    } catch {
      ctx.logger.warn("[traffic-lights] windowControls unmount failed");
    }
    try {
      await removeFallbackCss(ctx);
    } catch {
      ctx.logger.warn("[traffic-lights] fallback CSS cleanup failed");
    }
    try {
      const id = patchCssId;
      patchCssId = null;
      if (id !== null) {
        await ctx.css.remove(id);
      }
    } catch {
      ctx.logger.warn("[traffic-lights] dynamic CSS cleanup failed");
    } finally {
      patchCssId = null;
      fallbackCssId = null;
      controlObserverDisconnect = null;
      controlsObserved = false;
      overlayMounted = false;
      mountPending = false;
    }
    ctx.logger.info("[traffic-lights] deactivate: controls restored");
  } catch {
    try {
      ctx.logger.warn("[traffic-lights] deactivate failed");
    } catch {
      // Never reject.
    }
  }
}

const plugin: PluginModule<RendererContext> = {
  activate,
  deactivate,
};

export default plugin;
