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
 * Real window-control groups only (single comma-separated selector).
 * Pure `.titlebar` containers are intentionally excluded: they always match
 * and would suppress the decorative fallback even when no buttons exist.
 */
const WINDOW_CONTROL_SELECTOR: string =
  ".window-controls,.window-controls-container,.window-control," +
  '[class*="winButtons" i],[class*="winButton" i],' +
  '[class*="p-titlebar__controls" i],[class*="titlebar__controls" i],' +
  ".caption-buttons,.captionButtons,.frameless-controls," +
  ".traffic-lights,.mac-traffic-lights,.macos-traffic-lights,.titlebar-traffic-lights";

/**
 * Decorative fallback: a single `html::before` trio rendered via
 * `background` + `box-shadow`. Fixed position reusing the `--th-traffic-*`
 * variables, `pointer-events: none`, never interactive (no hover/active /
 * focus / cursor states, no close/minimize/maximize glyphs), hidden under
 * forced-colors mode.
 */
const DECORATIVE_FALLBACK_CSS: string =
  'html::before{content:"";position:fixed;left:var(--th-traffic-left,12px);' +
  "top:var(--th-traffic-top,12px);width:var(--th-traffic-size,12px);" +
  "height:var(--th-traffic-size,12px);border-radius:50%;background:#ff5f57;" +
  "box-shadow:calc(var(--th-traffic-size,12px) + var(--th-traffic-gap,8px)) 0 0 #febc2e," +
  "calc((var(--th-traffic-size,12px) + var(--th-traffic-gap,8px)) * 2) 0 0 #28c840;" +
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
 * Activate the plugin.
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

  let fallbackEnabled = true;
  try {
    fallbackEnabled = ctx.config.get("decorative-fallback-lights") !== false;
  } catch {
    ctx.logger.warn("[traffic-lights] config read failed");
    fallbackEnabled = false;
  }

  if (fallbackEnabled) {
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
    if (!queryFailed && !controlsFound) {
      let observeRegistered = false;
      try {
        const disconnect = ctx.dom.observe(WINDOW_CONTROL_SELECTOR, (_node) => {
          controlsObserved = true;
          disconnectControlObserver();
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
      if (observeRegistered) {
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
  try {
    patchCssId = await ctx.css.insert(
      ".titlebar .window-title{padding-left:var(--th-traffic-reserved,76px)}",
    );
  } catch {
    ctx.logger.warn("[traffic-lights] dynamic CSS patch failed");
    patchCssId = null;
  }
}

/**
 * Deactivate the plugin: disconnect the observer first, then clean up the
 * fallback and padding patches independently (one failure never skips the
 * other). Clears all module state and never rejects.
 */
export async function deactivate(ctx: RendererContext): Promise<void> {
  try {
    try {
      disconnectControlObserver();
    } catch {
      ctx.logger.warn("[traffic-lights] observer disconnect failed");
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
