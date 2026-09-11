/**
 * TronHawk plugin: Traffic Lights — renderer (CommonJS, QuickJS sandbox).
 *
 * Single source, typed inline with JSDoc (`tsc --noEmit` via allowJs/checkJs).
 * `manifest.json` points here because `vm.evalCode` only accepts CommonJS.
 *
 * CSS move when original controls are detected (static `style.css`, no JS
 * fallback), else host overlay (clickable) -> decorative `html::before`
 * fallback (not clickable) -> nothing. Overlay and fallback never co-show.
 *
 * Sandbox: no `console.*` (only `ctx.logger` strings); event callbacks
 * return `undefined`.
 *
 * NOTE: `renderer.script` is kept as the renderer execution gate (Core drops
 * the renderer payload without it or `runtime.unsafe`); no script call is
 * needed. Overlay geometry (`overlay-left-offset`/`overlay-region-height`) is
 * read host-side, never here — custom values need the matching host update.
 */

/**
 * @typedef {import("@tronhawk/sdk").RendererContext} RendererContext
 * @typedef {RendererContext & { windowControls?: unknown }} RendererContextWithOverlay
 * @typedef {{ mount(): Promise<void>, unmount(): Promise<void> }} HostWindowControls
 * @typedef {{ found: boolean, queryFailed: boolean, selector: string }} ControlsResolution
 */

/** Decorative fallback CSS id (single `html::before`, not clickable). Null when absent. @type {string | null} */
let fallbackCssId = null;
/** Disconnect function for the short-lived controls observer. Null when absent. @type {(() => void) | null} */
let controlObserverDisconnect = null;
/** Set by the observer callback when real controls appear. */
let controlsObserved = false;
/** True while the host overlay is mounted (never together with the fallback). */
let overlayMounted = false;
/** True while a `windowControls.mount()` is in flight. */
let mountPending = false;

/**
 * Real window-control groups only (single comma-separated selector).
 * Container tokens only: a bare `.titlebar` would always match, and bare
 * buttons outside a moved container must not suppress the overlay.
 */
const WINDOW_CONTROL_SELECTOR =
  ".window-controls,.window-controls-container,.window-control," +
  '[class*="window-controls" i],[class*="windowControls" i],' +
  '[class*="winButtons" i],' +
  '[class*="p-titlebar__controls" i],[class*="titlebar__controls" i],' +
  ".caption-buttons,.captionButtons,.frameless-controls,.header-controls," +
  ".titlebar-button-container.mod-right";

/**
 * Decorative fallback: a single `html::before` trio (`background` +
 * `box-shadow`), `pointer-events: none`, never interactive, hidden under
 * forced-colors mode.
 */
const DECORATIVE_FALLBACK_CSS =
  'html::before{content:"";position:fixed;left:var(--th-traffic-left,12px);' +
  "top:var(--th-traffic-top,12px);width:var(--th-traffic-size,14px);" +
  "height:var(--th-traffic-size,14px);border-radius:50%;background:#ff5f57;" +
  "box-shadow:calc(var(--th-traffic-size,14px) + var(--th-traffic-gap,10px)) 0 0 #febc2e," +
  "calc((var(--th-traffic-size,14px) + var(--th-traffic-gap,10px)) * 2) 0 0 #28c840;" +
  "pointer-events:none;z-index:9999}" +
  "@media (forced-colors:active){html::before{display:none !important}}";

/**
 * Return the host overlay API when present and well-formed, else null.
 * Must be called before every mount/unmount (never assume existence).
 * @param {RendererContext} ctx
 * @returns {HostWindowControls | null}
 */
function getWindowControls(ctx) {
  const candidate = /** @type {RendererContextWithOverlay} */ (ctx).windowControls;
  if (candidate === null || candidate === undefined) {
    return null;
  }
  if (typeof candidate !== "object") {
    return null;
  }
  const mount = /** @type {{ mount?: unknown }} */ (candidate).mount;
  const unmount = /** @type {{ unmount?: unknown }} */ (candidate).unmount;
  if (typeof mount !== "function" || typeof unmount !== "function") {
    return null;
  }
  return /** @type {HostWindowControls} */ (candidate);
}

/**
 * Transitional seam wrapping the single `ctx.dom.query(WINDOW_CONTROL_SELECTOR)`
 * call. Shape aligns with future host `getWindowControls` (found/queryFailed/
 * selector); after host rollout, only replace this function's implementation.
 * Pure refactor, zero behavior change.
 * @param {RendererContext} ctx
 * @returns {Promise<ControlsResolution>}
 */
async function resolveControls(ctx) {
  try {
    const found = await ctx.dom.query(WINDOW_CONTROL_SELECTOR);
    if (found !== null) {
      ctx.logger.info("[traffic-lights] window controls found");
      return { found: true, queryFailed: false, selector: WINDOW_CONTROL_SELECTOR };
    }
    return { found: false, queryFailed: false, selector: WINDOW_CONTROL_SELECTOR };
  } catch (_e) {
    ctx.logger.warn("[traffic-lights] controls query failed");
    return { found: false, queryFailed: true, selector: WINDOW_CONTROL_SELECTOR };
  }
}

/**
 * Remove the fallback CSS if present. Repeat-safe (second call is a no-op).
 * @param {RendererContext} ctx
 * @returns {Promise<void>}
 */
async function removeFallbackCss(ctx) {
  const id = fallbackCssId;
  fallbackCssId = null;
  if (id !== null) {
    try {
      await ctx.css.remove(id);
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] fallback CSS cleanup failed");
    }
  }
}

/**
 * Disconnect the controls observer if present. Clears the ref before calling.
 */
function disconnectControlObserver() {
  const disconnect = controlObserverDisconnect;
  controlObserverDisconnect = null;
  if (disconnect !== null) {
    try {
      disconnect();
    } catch (_e) {
      // Synchronous host callback; ignore errors so deactivate never rejects.
    }
  }
}

/**
 * Unmount the overlay when mounted. Flag-gated so a fresh
 * activate/deactivate without a prior mount never touches the host.
 * Never rejects: failures only warn, state is always cleared.
 * @param {RendererContext} ctx
 * @returns {Promise<void>}
 */
async function unmountOverlay(ctx) {
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
  } catch (_e) {
    ctx.logger.warn("[traffic-lights] windowControls unmount failed");
  }
}

/**
 * Cancel an in-flight `windowControls.mount()` by issuing a host `unmount()`
 * while still pending, so a late mount success never sticks around next to
 * real controls (or as residue after deactivate). Best-effort, never rejects.
 * @param {RendererContext} ctx
 * @returns {Promise<void>}
 */
async function cancelPendingMount(ctx) {
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
  } catch (_e) {
    ctx.logger.warn("[traffic-lights] windowControls unmount failed");
  }
}

/**
 * Activate the plugin. Downgrade order on a full miss (no original controls):
 * real controls (CSS move, no JS fallback) -> host overlay
 * (`ctx.windowControls.mount`, clickable) -> decorative fallback
 * (`html::before`, pointer-events none, not clickable) -> nothing.
 * The overlay and the decorative fallback are never shown together.
 * @param {RendererContext} ctx
 * @returns {Promise<void>}
 */
async function activate(ctx) {
  ctx.logger.info("[traffic-lights] activate: moving controls to top-left");
  controlsObserved = false;
  mountPending = false;
  await unmountOverlay(ctx);
  overlayMounted = false;

  let decorativeEnabled = true;
  let overlayEnabled = true;
  try {
    decorativeEnabled = ctx.config.get("decorative-fallback-lights") !== false;
    overlayEnabled = ctx.config.get("host-overlay-fallback") !== false;
  } catch (_e) {
    ctx.logger.warn("[traffic-lights] config read failed");
    decorativeEnabled = false;
    overlayEnabled = false;
  }

  const resolution = await resolveControls(ctx);
  const controlsFound = resolution.found;
  const queryFailed = resolution.queryFailed;

  if (controlsFound) {
    await unmountOverlay(ctx);
  } else if (!queryFailed) {
    let observeRegistered = false;
    const overlayAvailable =
      overlayEnabled && getWindowControls(ctx) !== null;
    if (decorativeEnabled || overlayAvailable) {
      try {
        const disconnect = ctx.dom.observe(WINDOW_CONTROL_SELECTOR, (_node) => {
          controlsObserved = true;
          disconnectControlObserver();
          void cancelPendingMount(ctx);
          void unmountOverlay(ctx);
          void removeFallbackCss(ctx);
          return undefined;
        });
        controlObserverDisconnect = disconnect;
        observeRegistered = true;
      } catch (_e) {
        ctx.logger.warn("[traffic-lights] controls observe failed");
        controlObserverDisconnect = null;
        observeRegistered = false;
      }
    }

    let overlayActive = false;
    if (overlayEnabled && observeRegistered) {
      const wc = getWindowControls(ctx);
      if (wc !== null) {
        mountPending = true;
        try {
          await wc.mount();
          if (!mountPending || controlsObserved) {
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
        } catch (_e) {
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
      if (decorativeEnabled && observeRegistered && !controlsObserved) {
        try {
          fallbackCssId = await ctx.css.insert(DECORATIVE_FALLBACK_CSS);
        } catch (_e) {
          ctx.logger.warn("[traffic-lights] fallback CSS insert failed");
          fallbackCssId = null;
          disconnectControlObserver();
        }
        if (fallbackCssId !== null && controlsObserved) {
          await removeFallbackCss(ctx);
        }
      }
      if (!overlayMounted && fallbackCssId === null && !decorativeEnabled) {
        disconnectControlObserver();
      }
    }
  }
}

/**
 * Deactivate the plugin: disconnect the observer first, then cancel any
 * pending mount and unmount the overlay, then clean up the fallback patch
 * independently (one failure never skips the other).
 * Clears all module state and never rejects.
 * @param {RendererContext} ctx
 * @returns {Promise<void>}
 */
async function deactivate(ctx) {
  try {
    try {
      disconnectControlObserver();
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] observer disconnect failed");
    }
    try {
      await cancelPendingMount(ctx);
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] windowControls unmount failed");
    }
    try {
      await unmountOverlay(ctx);
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] windowControls unmount failed");
    }
    try {
      await removeFallbackCss(ctx);
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] fallback CSS cleanup failed");
    } finally {
      fallbackCssId = null;
      controlObserverDisconnect = null;
      controlsObserved = false;
      overlayMounted = false;
      mountPending = false;
    }
    ctx.logger.info("[traffic-lights] deactivate: controls restored");
  } catch (_e) {
    try {
      ctx.logger.warn("[traffic-lights] deactivate failed");
    } catch (_e2) {
      // Never reject.
    }
  }
}

module.exports = { activate, deactivate };
