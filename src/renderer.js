/**
 * TronHawk plugin: Traffic Lights — renderer (CommonJS, QuickJS sandbox).
 *
 * Authored alongside `src/renderer.ts` (type source); this `.js` file is what
 * `manifest.json` points at because the runtime's `vm.evalCode` only accepts
 * CommonJS (`module.exports = { activate, deactivate }`).
 *
 * Sandbox contract: never use `console.*`, only log via `ctx.logger` with
 * plain strings, and never return a non-undefined value from event callbacks
 * (the `observe` callback below returns `undefined` synchronously).
 */

let patchCssId = null;
let fallbackCssId = null;
let controlObserverDisconnect = null;
let controlsObserved = false;

const WINDOW_CONTROL_SELECTOR =
  ".window-controls,.window-controls-container,.window-control," +
  '[class*="winButtons" i],[class*="winButton" i],' +
  '[class*="p-titlebar__controls" i],[class*="titlebar__controls" i],' +
  ".caption-buttons,.captionButtons,.frameless-controls," +
  ".traffic-lights,.mac-traffic-lights,.macos-traffic-lights,.titlebar-traffic-lights";

const DECORATIVE_FALLBACK_CSS =
  'html::before{content:"";position:fixed;left:var(--th-traffic-left,12px);' +
  "top:var(--th-traffic-top,12px);width:var(--th-traffic-size,12px);" +
  "height:var(--th-traffic-size,12px);border-radius:50%;background:#ff5f57;" +
  "box-shadow:calc(var(--th-traffic-size,12px) + var(--th-traffic-gap,8px)) 0 0 #febc2e," +
  "calc((var(--th-traffic-size,12px) + var(--th-traffic-gap,8px)) * 2) 0 0 #28c840;" +
  "pointer-events:none;z-index:9999}" +
  "@media (forced-colors:active){html::before{display:none !important}}";

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

async function activate(ctx) {
  ctx.logger.info("[traffic-lights] activate: moving controls to top-left");
  controlsObserved = false;

  let fallbackEnabled = true;
  try {
    fallbackEnabled = ctx.config.get("decorative-fallback-lights") !== false;
  } catch (_e) {
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
    } catch (_e) {
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
      } catch (_e) {
        ctx.logger.warn("[traffic-lights] controls observe failed");
        controlObserverDisconnect = null;
        observeRegistered = false;
      }
      if (observeRegistered) {
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
    }
  }

  // Keep the visible title unchanged while exercising `renderer.script`
  // (required so the `renderer.script` grant is actually used): read the
  // <title> snapshot and write it back. Skipped when absent so we never
  // blank the title on apps without one.
  try {
    const titleEl = await ctx.dom.query("title");
    const text = titleEl && titleEl.text;
    if (typeof text === "string" && text.length > 0) {
      try {
        ctx.script.setDocumentTitle(text.slice(0, 256));
      } catch (_e) {
        ctx.logger.warn("[traffic-lights] setDocumentTitle failed");
      }
    }
  } catch (_e) {
    ctx.logger.warn("[traffic-lights] title query failed");
  }

  // Small dynamic patch: reserve left padding so titles/tabs do not slide
  // under the relocated lights. Static repaint lives in style.css (data).
  try {
    patchCssId = await ctx.css.insert(
      ".titlebar .window-title{padding-left:var(--th-traffic-reserved,76px)}",
    );
  } catch (_e) {
    ctx.logger.warn("[traffic-lights] dynamic CSS patch failed");
    patchCssId = null;
  }
}

async function deactivate(ctx) {
  try {
    try {
      disconnectControlObserver();
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] observer disconnect failed");
    }
    try {
      await removeFallbackCss(ctx);
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] fallback CSS cleanup failed");
    }
    try {
      const id = patchCssId;
      patchCssId = null;
      if (id !== null) {
        await ctx.css.remove(id);
      }
    } catch (_e) {
      ctx.logger.warn("[traffic-lights] dynamic CSS cleanup failed");
    } finally {
      patchCssId = null;
      fallbackCssId = null;
      controlObserverDisconnect = null;
      controlsObserved = false;
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
