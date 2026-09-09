// Renderer tests for the traffic-lights single source (bun test, no host).
import { beforeEach, describe, expect, test } from "bun:test";

import { createMockRendererContext } from "@tronhawk/sdk";
import plugin from "./renderer.js";

function makeTrackingCtx(opts: {
  configValue?: unknown;
  configThrows?: boolean;
  queryImpl?: (selector: string) => Promise<unknown>;
  observeThrows?: boolean;
  insertThrowsForFallback?: boolean;
  removeShouldThrow?: (id: string) => boolean;
} = {}) {
  const inserts: string[] = [];
  const removes: string[] = [];
  const queries: string[] = [];
  const observes: Array<{ selector: string; cb: (node: never) => unknown }> = [];
  let disconnectCalls = 0;
  let insertSeq = 0;

  const ctx = createMockRendererContext({
    // oxlint-disable-next-line no-explicit-any
    config: {
      get: (key: string) => {
        if (opts.configThrows) throw new Error("config failed");
        if (key === "decorative-fallback-lights") return opts.configValue;
        return undefined;
      },
      set: () => {},
      // oxlint-disable-next-line no-explicit-any
    } as any,
    // oxlint-disable-next-line no-explicit-any
    css: {
      insert: async (css: string) => {
        inserts.push(css);
        const isFallback = css.includes("pointer-events:none");
        if (isFallback && opts.insertThrowsForFallback) {
          throw new Error("fallback insert failed");
        }
        insertSeq += 1;
        return `mock-css-${insertSeq}`;
      },
      remove: async (id: string) => {
        removes.push(id);
        if (opts.removeShouldThrow?.(id)) throw new Error("remove failed for " + id);
      },
      // oxlint-disable-next-line no-explicit-any
    } as any,
    // oxlint-disable-next-line no-explicit-any
    dom: {
      query: async (selector: string) => {
        queries.push(selector);
        if (opts.queryImpl) return opts.queryImpl(selector) as never;
        return null as never;
      },
      observe: ((selector: string, cb: (node: never) => unknown) => {
        queries.push(`observe:${selector}`);
        observes.push({ selector, cb });
        if (opts.observeThrows) throw new Error("observe failed");
        return () => {
          disconnectCalls += 1;
        };
        // oxlint-disable-next-line no-explicit-any
      }) as any,
      // oxlint-disable-next-line no-explicit-any
    } as any,
  });
  return { ctx, inserts, removes, queries, observes, disconnects: () => disconnectCalls };
}

function hitElement() {
  return {
    nodeId: 1,
    tag: "div",
    id: "",
    className: "window-controls",
    attrs: {},
    text: "",
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const file = Bun.file(`${import.meta.dir}/${path}`);
  return (await file.json()) as Record<string, unknown>;
}

async function readText(path: string): Promise<string> {
  return await Bun.file(`${import.meta.dir}/${path}`).text();
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

beforeEach(async () => {
  await plugin.deactivate(createMockRendererContext());
});

describe("renderer entry", () => {
  test("exposes activate/deactivate", () => {
    expect(typeof plugin.activate).toBe("function");
    expect(typeof plugin.deactivate).toBe("function");
  });

  test("activate/deactivate run against a mock renderer context", async () => {
    const ctx = createMockRendererContext();
    await plugin.activate(ctx);
    await plugin.deactivate(ctx);
  });
});

describe("manifest decorative-fallback-lights", () => {
  test("declares boolean type, default true, label mentions decorative + not clickable", async () => {
    const manifest = await readJson("../manifest.json");
    const config = manifest["config"] as Record<string, Record<string, unknown>>;
    expect(config).toBeDefined();
    const field = config["decorative-fallback-lights"];
    expect(field).toBeDefined();
    expect(field["type"]).toBe("boolean");
    expect(field["default"]).toBe(true);
    const label = String(field["label"] ?? "");
    expect(label.toLowerCase()).toContain("decorative");
    expect(label.toLowerCase()).toContain("not clickable");
  });

  test("single source carries the detection + fallback contract", async () => {
    // Single source (src/renderer.js): no TS twin remains. Locks the
    // behavior-relevant contract only — detection matrix, config keys, and
    // the absence of the removed title/padding paths — never internals.
    const src = await readText("./renderer.js");
    expect(src).toContain("WINDOW_CONTROL_SELECTOR");
    expect(src).toContain("DECORATIVE_FALLBACK_CSS");
    expect(src).toContain('ctx.config.get("decorative-fallback-lights") !== false');
    expect(src).toContain('ctx.config.get("host-overlay-fallback") !== false');
    // Breaking rename: no compat shim, no stale old-key reference.
    expect(src).not.toContain("functional-fallback");
    // Removed paths stay removed: no title read-back, no runtime padding.
    expect(src).not.toContain("setDocumentTitle");
    expect(src).not.toContain("patchCssId");
    expect(src).not.toContain("--th-traffic-reserved");
    expect(src).not.toContain('query("title")');
    // Closed detection matrix: every moved container is detected, and the
    // selector stays a single comma-separated container-only list.
    for (const token of [
      ".window-controls",
      ".window-controls-container",
      ".window-control",
      "winButtons",
      "windowControls",
      "p-titlebar__controls",
      "titlebar__controls",
      ".caption-buttons",
      ".captionButtons",
      ".frameless-controls",
      ".header-controls",
      ".titlebar-button-container.mod-right",
    ]) {
      expect(src).toContain(token);
    }
    expect(src).toContain('[class*="winButtons" i]');
    expect(src).not.toContain('[class*="winButton" i]');
    expect(src).not.toContain("WINDOW_CONTROL_SELECTORS");
  });

  test("style.css adds no permanent html::before/body::before rule", async () => {
    const css = await readText("../style.css");
    const stripped = stripCssComments(css);
    expect(stripped).not.toContain("html::before");
    expect(stripped).not.toContain("body::before");
    expect(css).toContain("--th-traffic-size");
  });
});

describe("decorative fallback behavior", () => {
  test("config false disables fallback: no observe, no fallback insert", async () => {
    const t = makeTrackingCtx({
      configValue: false,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      // No runtime CSS at all: the static style.css reserve covers titles.
      expect(t.inserts.length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("config undefined is treated as enabled", async () => {
    const t = makeTrackingCtx({
      configValue: undefined,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(1);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("hit does not insert fallback and does not observe", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async () => hitElement(),
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      // Move path needs no runtime CSS: the static style.css does the move.
      expect(t.inserts.length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("miss registers observe once and inserts fallback once with pointer-events:none", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(1);
      const fallbacks = t.inserts.filter((c) => c.includes("pointer-events:none"));
      expect(fallbacks.length).toBe(1);
      const css = fallbacks[0];
      expect(css).toContain("html::before");
      expect(css).toContain('content:""');
      expect(css).toContain("position:fixed");
      expect(css).toContain("--th-traffic-size");
      expect(css).toContain("--th-traffic-gap");
      expect(css).toContain("--th-traffic-left");
      expect(css).toContain("--th-traffic-top");
      expect(css).toContain("pointer-events:none");
      expect(css).toContain("forced-colors");
      expect(css).not.toContain(":hover");
      expect(css).not.toContain(":focus");
      expect(css.toLowerCase()).not.toContain("cursor:");
      expect(css).not.toContain("×");
      expect(css).not.toContain("–");
      expect(css).not.toContain('content:"+"');
      expect(css.replace(/forced-colors\s*:\s*active/g, "")).not.toContain(":active");
      // Single-shot detection: exactly one controls query (title query is separate).
      const controlQueries = t.queries.filter((s) => !s.startsWith("observe:"));
      expect(controlQueries.length).toBe(1);
      // Single comma-separated selector covering real control groups, no pure .titlebar token.
      const selector = controlQueries[0];
      expect(selector).toContain(",");
      for (const token of [
        ".window-controls",
        ".window-controls-container",
        ".window-control",
        "winButtons",
        "windowControls",
        "p-titlebar__controls",
        "titlebar__controls",
        ".caption-buttons",
        ".captionButtons",
        ".frameless-controls",
        ".header-controls",
        ".traffic-lights",
      ".titlebar-button-container.mod-right",
    ]) {
      expect(selector).toContain(token);
    }
      // Closed detection: only the precise Obsidian container moves, never
      // bare buttons; Discord moves div[winButtons] only, never a bare
      // singular winButton outside it (CSS D tier still repaints the
      // container's child buttons, but detection must not fire on them).
      expect(selector).toContain('[class*="winButtons" i]');
      expect(selector).not.toContain('[class*="winButton" i]');
      expect(selector).not.toContain(".titlebar-button.mod-minimize");
      expect(selector).not.toContain(".titlebar-button.mod-maximize");
      expect(selector).not.toContain(".titlebar-button.mod-close");
      const parts = selector
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(parts).not.toContain(".titlebar");
      expect(parts).not.toContain(".title-bar");
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("obsidian right container hits, pure .titlebar alone still excluded", async () => {
    // Simulate Obsidian DOM:
    // <div class="titlebar-button-container mod-right">
    //   <div class="titlebar-button mod-minimize" aria-label="最小化">
    // Only the precise compound token matches; a bare `.titlebar` div
    // must not suppress the fallback (see parts check below).
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async (selector) => {
        if (selector.includes("titlebar-button-container.mod-right")) {
          return hitElement();
        }
        return null;
      },
    });
    await plugin.activate(t.ctx);
    try {
      // Hit path: real Obsidian controls found, no fallback, no observer.
      expect(t.observes.length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      // Move path needs no runtime CSS: the static style.css reserve covers titles.
      expect(t.inserts.length).toBe(0);
      const controlQueries = t.queries.filter((s) => !s.startsWith("observe:"));
      expect(controlQueries.length).toBe(1);
      const selector = controlQueries[0];
      expect(selector).toContain("titlebar-button-container.mod-right");
      // Closed detection: bare buttons outside the moved container must not
      // suppress the overlay (CSS only repaints
      // `.titlebar-button-container.mod-right .titlebar-button`).
      expect(selector).not.toContain(".titlebar-button.mod-minimize");
      expect(selector).not.toContain(".titlebar-button.mod-maximize");
      expect(selector).not.toContain(".titlebar-button.mod-close");
      // Discord singular too: only div[winButtons] moves, a bare singular
      // button outside it must not suppress the overlay.
      expect(selector).toContain('[class*="winButtons" i]');
      expect(selector).not.toContain('[class*="winButton" i]');
      // Pure `.titlebar` alone must not be a selector part, otherwise any
      // bare titlebar div would suppress the fallback even with no buttons.
      const parts = selector
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(parts).not.toContain(".titlebar");
      expect(parts).not.toContain(".title-bar");
      expect(parts).not.toContain('[class*="titlebar-button"]');
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("observe callback removes fallback, disconnects once, returns undefined", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(1);
      const fallbacks = t.inserts.filter((c) => c.includes("pointer-events:none"));
      expect(fallbacks.length).toBe(1);
      const cb = t.observes[0].cb;
      const removesBefore = t.removes.length;
      const ret = (cb as (n: unknown) => unknown)(hitElement());
      expect(ret).toBeUndefined();
      expect(t.disconnects()).toBe(1);
      expect(t.removes.length).toBe(removesBefore + 1);
      // Repeat-safe: second deactivate does not duplicate removes.
      const removesAfterCallback = t.removes.length;
      await plugin.deactivate(t.ctx);
      // The fallback id must appear exactly once.
      const fallbackId = "mock-css-1";
      expect(t.removes.filter((id) => id === fallbackId).length).toBe(1);
      expect(t.removes.length).toBeGreaterThanOrEqual(removesAfterCallback);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("insert race: controls observed during insert are removed immediately", async () => {
    let capturedCb: ((n: unknown) => unknown) | null = null;
    let resolveInsert!: (id: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveInsert = resolve;
    });
    const inserts: string[] = [];
    const removes: string[] = [];
    const queries: string[] = [];
    let disconnectCalls = 0;
    const ctx = createMockRendererContext({
      // oxlint-disable-next-line no-explicit-any
      config: { get: () => true, set: () => {} } as any,
      // oxlint-disable-next-line no-explicit-any
      css: {
        insert: async (css: string) => {
          inserts.push(css);
          return await gate;
        },
        remove: async (id: string) => {
          removes.push(id);
        },
        // oxlint-disable-next-line no-explicit-any
      } as any,
      // oxlint-disable-next-line no-explicit-any
      dom: {
        query: async (selector: string) => {
          queries.push(selector);
          return null as never;
        },
        observe: ((selector: string, cb: (n: unknown) => unknown) => {
          capturedCb = cb;
          return () => {
            disconnectCalls += 1;
          };
          // oxlint-disable-next-line no-explicit-any
        }) as any,
        // oxlint-disable-next-line no-explicit-any
      } as any,
    });
    const activating = plugin.activate(ctx);
    // Wait until observe is registered, then fire it before insert resolves.
    for (let i = 0; i < 100 && capturedCb === null; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(capturedCb).not.toBeNull();
    const ret = (capturedCb as unknown as (n: unknown) => unknown)(hitElement());
    expect(ret).toBeUndefined();
    resolveInsert("mock-fallback-race");
    await activating;
    try {
      // Fallback was inserted then immediately removed due to the race.
      expect(inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(1);
      expect(removes).toContain("mock-fallback-race");
    } finally {
      await plugin.deactivate(ctx);
    }
  });

  test("deactivate cleans the fallback patch and removes its id once", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    expect(t.inserts.length).toBe(1);
    const removesBefore = t.removes.length;
    await plugin.deactivate(t.ctx);
    expect(t.removes.length).toBe(removesBefore + 1);
    expect(new Set(t.removes).size).toBe(t.removes.length);
    const countAfterFirst = t.removes.length;
    await plugin.deactivate(t.ctx);
    expect(t.removes.length).toBe(countAfterFirst);
  });

  test("query throw fails closed: no fallback, no observe", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async () => {
        throw new Error("bad selector");
      },
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("observe throw fails closed: no fallback insert", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      observeThrows: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(1);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("fallback insert failure disconnects the observer", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      insertThrowsForFallback: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(1);
      expect(t.disconnects()).toBe(1);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("remove failure does not block the remaining cleanup", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async () => null,
      removeShouldThrow: (id) => id === "mock-css-1",
    });
    await plugin.activate(t.ctx);
    // mock-css-1 is the fallback insert (the only runtime insert now).
    await expect(plugin.deactivate(t.ctx)).resolves.toBeUndefined();
    expect(t.removes).toContain("mock-css-1");
    // State is cleared: a second deactivate performs no further removes.
    const n = t.removes.length;
    await plugin.deactivate(t.ctx);
    expect(t.removes.length).toBe(n);
  });
});

function makeOverlayCtx(opts: {
  decorativeValue?: unknown;
  overlayValue?: unknown;
  mountImpl?: () => Promise<void>;
  unmountImpl?: () => Promise<void>;
  queryImpl?: (selector: string) => Promise<unknown>;
  observeThrows?: boolean;
} = {}) {
  const inserts: string[] = [];
  const removes: string[] = [];
  const queries: string[] = [];
  const observes: Array<{ selector: string; cb: (node: never) => unknown }> = [];
  let disconnectCalls = 0;
  let mountCalls = 0;
  let unmountCalls = 0;
  const mountArgs: unknown[][] = [];
  let insertSeq = 0;

  const base = createMockRendererContext({
    // oxlint-disable-next-line no-explicit-any
    config: {
      get: (key: string) => {
        if (key === "decorative-fallback-lights") return opts.decorativeValue;
        if (key === "host-overlay-fallback") return opts.overlayValue;
        return undefined;
      },
      set: () => {},
      // oxlint-disable-next-line no-explicit-any
    } as any,
    // oxlint-disable-next-line no-explicit-any
    css: {
      insert: async (css: string) => {
        inserts.push(css);
        insertSeq += 1;
        return `mock-css-${insertSeq}`;
      },
      remove: async (id: string) => {
        removes.push(id);
      },
      // oxlint-disable-next-line no-explicit-any
    } as any,
    // oxlint-disable-next-line no-explicit-any
    dom: {
      query: async (selector: string) => {
        queries.push(selector);
        if (opts.queryImpl) return opts.queryImpl(selector) as never;
        return null as never;
      },
      observe: ((selector: string, cb: (node: never) => unknown) => {
        queries.push(`observe:${selector}`);
        observes.push({ selector, cb });
        if (opts.observeThrows) throw new Error("observe failed");
        return () => {
          disconnectCalls += 1;
        };
        // oxlint-disable-next-line no-explicit-any
      }) as any,
      // oxlint-disable-next-line no-explicit-any
    } as any,
  });
  // Old SDK mock has no windowControls; attach it for overlay tests.
  // oxlint-disable-next-line no-explicit-any
  (base as any).windowControls = {
    mount: async (...args: unknown[]) => {
      mountCalls += 1;
      mountArgs.push(args);
      if (opts.mountImpl) await opts.mountImpl();
    },
    unmount: async () => {
      unmountCalls += 1;
      if (opts.unmountImpl) await opts.unmountImpl();
    },
  };
  return {
    ctx: base,
    inserts,
    removes,
    queries,
    observes,
    disconnects: () => disconnectCalls,
    mounts: () => mountCalls,
    mountArgs: () => mountArgs,
    unmounts: () => unmountCalls,
  };
}

function makeNoOverlayCtx(opts: {
  decorativeValue?: unknown;
  overlayValue?: unknown;
  queryImpl?: (selector: string) => Promise<unknown>;
} = {}) {
  const inserts: string[] = [];
  const removes: string[] = [];
  const observes: Array<{ selector: string; cb: (node: never) => unknown }> = [];
  let disconnectCalls = 0;
  let insertSeq = 0;
  const base = createMockRendererContext({
    // oxlint-disable-next-line no-explicit-any
    config: {
      get: (key: string) => {
        if (key === "decorative-fallback-lights") return opts.decorativeValue;
        if (key === "host-overlay-fallback") return opts.overlayValue;
        return undefined;
      },
      set: () => {},
      // oxlint-disable-next-line no-explicit-any
    } as any,
    // oxlint-disable-next-line no-explicit-any
    css: {
      insert: async (css: string) => {
        inserts.push(css);
        insertSeq += 1;
        return `mock-css-${insertSeq}`;
      },
      remove: async (id: string) => {
        removes.push(id);
      },
      // oxlint-disable-next-line no-explicit-any
    } as any,
    // oxlint-disable-next-line no-explicit-any
    dom: {
      query: async (selector: string) => {
        if (opts.queryImpl) return opts.queryImpl(selector) as never;
        return null as never;
      },
      observe: ((selector: string, cb: (node: never) => unknown) => {
        observes.push({ selector, cb });
        return () => {
          disconnectCalls += 1;
        };
        // oxlint-disable-next-line no-explicit-any
      }) as any,
      // oxlint-disable-next-line no-explicit-any
    } as any,
  });
  // Simulate an old host with no windowControls API at all.
  // oxlint-disable-next-line no-explicit-any
  delete (base as any).windowControls;
  return {
    ctx: base,
    inserts,
    removes,
    observes,
    disconnects: () => disconnectCalls,
  };
}

describe("manifest host-overlay-fallback", () => {
  test("declares electron.windowControls permission", async () => {
    const manifest = await readJson("../manifest.json");
    const permissions = manifest["permissions"] as unknown[];
    expect(permissions).toContain("electron.windowControls");
    expect(permissions).toContain("renderer.css");
    expect(permissions).toContain("renderer.dom");
    expect(permissions).toContain("renderer.script");
  });

  test("declares host-overlay-fallback boolean default true with functional host overlay label", async () => {
    const manifest = await readJson("../manifest.json");
    const config = manifest["config"] as Record<string, Record<string, unknown>>;
    const field = config["host-overlay-fallback"];
    expect(field).toBeDefined();
    expect(field["type"]).toBe("boolean");
    expect(field["default"]).toBe(true);
    const label = String(field["label"] ?? "").toLowerCase();
    expect(label).toContain("functional host overlay");
  });

  test("single source carries the host-overlay contract", async () => {
    // Single source (src/renderer.js): locks the behavior-relevant overlay
    // contract only — new config key, mount/unmount calls, and the runtime
    // shape check — never internals.
    const src = await readText("./renderer.js");
    expect(src).toContain('ctx.config.get("host-overlay-fallback") !== false');
    expect(src).toContain("windowControls");
    expect(src).toContain("mount()");
    expect(src).toContain("unmount()");
    expect(src).not.toContain("functional-fallback-controls");
    // Runtime checks the host shape before calling.
    expect(src).toContain('typeof mount !== "function"');
    expect(src).toContain('typeof unmount !== "function"');
  });
});

describe("functional fallback (host overlay) behavior", () => {
  test("mount priority: miss mounts overlay and skips decorative lights", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.mounts()).toBe(1);
      // Declarative contract: mount takes no arguments (geometry comes from
      // the host-side plan config snapshot, never from the renderer).
      expect(t.mountArgs().length).toBe(1);
      expect(t.mountArgs()[0].length).toBe(0);
      expect(t.unmounts()).toBe(0);
      // Observer stays for late-appearing controls.
      expect(t.observes.length).toBe(1);
      // Never both: no decorative insert when the overlay is up.
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      // Overlay path needs no runtime CSS at all.
      expect(t.inserts.length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("mount reject falls back to decorative lights", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      mountImpl: async () => {
        throw new Error("mount denied");
      },
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.mounts()).toBe(1);
      expect(t.unmounts()).toBe(0);
      expect(t.observes.length).toBe(1);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("functional disabled never mounts even when the host API exists", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: false,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.mounts()).toBe(0);
      expect(t.unmounts()).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("config undefined enables the functional overlay", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: undefined,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.mounts()).toBe(1);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("hit never mounts and never inserts decorative lights", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      queryImpl: async () => hitElement(),
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.mounts()).toBe(0);
      expect(t.unmounts()).toBe(0);
      expect(t.observes.length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("old host without windowControls falls back to decorative lights", async () => {
    const t = makeNoOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(1);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("late controls unmount the overlay, disconnect once, return undefined", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.mounts()).toBe(1);
      expect(t.observes.length).toBe(1);
      const cb = t.observes[0].cb;
      const ret = (cb as (n: unknown) => unknown)(hitElement());
      expect(ret).toBeUndefined();
      expect(t.disconnects()).toBe(1);
      // Overlay unmounted exactly once via the observer fast path.
      expect(t.unmounts()).toBe(1);
      // No decorative insert at any point: never both.
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      const unmountsAfterCallback = t.unmounts();
      await plugin.deactivate(t.ctx);
      // Deactivate does not duplicate the unmount.
      expect(t.unmounts()).toBe(unmountsAfterCallback);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("deactivate unmounts the overlay once and never rejects", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    expect(t.mounts()).toBe(1);
    await expect(plugin.deactivate(t.ctx)).resolves.toBeUndefined();
    expect(t.unmounts()).toBe(1);
    // Decorative was never inserted and no runtime CSS was needed; unmount not repeated.
    expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
    const n = t.unmounts();
    await expect(plugin.deactivate(t.ctx)).resolves.toBeUndefined();
    expect(t.unmounts()).toBe(n);
  });

  test("deactivate still disconnects when overlay unmount throws", async () => {
    const inserts: string[] = [];
    const removes: string[] = [];
    let mountCalls = 0;
    let unmountCalls = 0;
    let disconnectCalls = 0;
    const ctx = createMockRendererContext({
      // oxlint-disable-next-line no-explicit-any
      config: { get: () => true, set: () => {} } as any,
      // oxlint-disable-next-line no-explicit-any
      css: {
        insert: async (css: string) => {
          inserts.push(css);
          return "mock-css-fallback";
        },
        remove: async (id: string) => {
          removes.push(id);
          throw new Error("remove failed");
        },
        // oxlint-disable-next-line no-explicit-any
      } as any,
      // oxlint-disable-next-line no-explicit-any
      dom: {
        query: async () => null as never,
        observe: (() => {
          return () => {
            disconnectCalls += 1;
          };
          // oxlint-disable-next-line no-explicit-any
        }) as any,
        // oxlint-disable-next-line no-explicit-any
      } as any,
    });
    // oxlint-disable-next-line no-explicit-any
    (ctx as any).windowControls = {
      mount: async () => {
        mountCalls += 1;
      },
      unmount: async () => {
        unmountCalls += 1;
        throw new Error("unmount failed");
      },
    };
    await plugin.activate(ctx);
    expect(mountCalls).toBe(1);
    // Overlay up means decorative skipped and no runtime CSS was inserted.
    expect(inserts.length).toBe(0);
    // Failures only warn: deactivate still resolves and still disconnects.
    await expect(plugin.deactivate(ctx)).resolves.toBeUndefined();
    expect(unmountCalls).toBe(1);
    expect(disconnectCalls).toBe(1);
    expect(removes.length).toBe(0);
    await plugin.deactivate(ctx);
  });

  test("observe failure fails closed: no overlay mount and no decorative insert", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      observeThrows: true,
      queryImpl: async () => null,
    });
    await plugin.activate(t.ctx);
    try {
      // Observer was attempted but registration failed.
      expect(t.observes.length).toBe(1);
      expect(t.disconnects()).toBe(0);
      // Fail closed: without late-controls detection the overlay must not mount.
      expect(t.mounts()).toBe(0);
      expect(t.unmounts()).toBe(0);
      // Decorative tier fails closed too (existing behavior).
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      // No runtime CSS at all without the observer.
      expect(t.inserts.length).toBe(0);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("deferred mount race: observer firing while mount is pending cancels it promptly", async () => {
    let resolveMount!: () => void;
    const mountGate = new Promise<void>((resolve) => {
      resolveMount = resolve;
    });
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      mountImpl: () => mountGate,
      queryImpl: async () => null,
    });
    const activating = plugin.activate(t.ctx);
    // Wait until the observer is registered and the mount is in flight.
    for (let i = 0; i < 200 && (t.observes.length === 0 || t.mounts() === 0); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(t.observes.length).toBe(1);
    expect(t.mounts()).toBe(1);
    expect(t.unmounts()).toBe(0);
    // Late controls appear while mount is still pending: cancel it.
    const ret = (t.observes[0].cb as (n: unknown) => unknown)(hitElement());
    expect(ret).toBeUndefined();
    expect(t.disconnects()).toBe(1);
    // Prompt cancel: the host unmount is issued while the mount is still
    // pending, before it settles — no brief overlay window, and no residue
    // even if the mount never settles.
    expect(t.unmounts()).toBe(1);
    resolveMount();
    await activating;
    try {
      // Mount was attempted once; its late success was neutralized.
      expect(t.mounts()).toBe(1);
      // Never both, and no decorative either: single final state (move path).
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      const unmountsAfterRace = t.unmounts();
      await plugin.deactivate(t.ctx);
      expect(t.unmounts()).toBe(unmountsAfterRace);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("deactivate while mount is pending issues unmount immediately", async () => {
    let resolveMount!: () => void;
    const mountGate = new Promise<void>((resolve) => {
      resolveMount = resolve;
    });
    const t = makeOverlayCtx({
      decorativeValue: true,
      overlayValue: true,
      mountImpl: () => mountGate,
      queryImpl: async () => null,
    });
    const activating = plugin.activate(t.ctx);
    // Wait until the observer is registered and the mount is in flight.
    for (let i = 0; i < 200 && (t.observes.length === 0 || t.mounts() === 0); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(t.observes.length).toBe(1);
    expect(t.mounts()).toBe(1);
    // Deactivate while the mount is still pending: the cancel must reach
    // the host before the mount settles.
    await plugin.deactivate(t.ctx);
    expect(t.disconnects()).toBe(1);
    expect(t.unmounts()).toBe(1);
    resolveMount();
    await activating;
    // Late success is neutralized (never marked active); final cleanup is
    // stable and never rejects.
    const unmountsAfterSettle = t.unmounts();
    await expect(plugin.deactivate(t.ctx)).resolves.toBeUndefined();
    expect(t.unmounts()).toBe(unmountsAfterSettle);
  });
});

describe("obsidian positioning regression (verified 1.13.7 hidden-frameless)", () => {
  test("reserve rules never pad the relocated cluster itself", async () => {
    // Regression: a broad `[class*="titlebar"] [class*="title"]` reserve
    // selector matched `.titlebar-button-container.mod-right` (and every
    // `.titlebar-button` inside it), injecting padding INSIDE the moved box
    // so the lamps slid right onto the tab-strip icons. Only explicit
    // title-text classes may carry the reserve (comments excluded: the
    // regression note in style.css quotes the forbidden selector as docs).
    const css = stripCssComments(await readText("../style.css"));
    expect(css).not.toContain('[class*="title" i]');
    expect(css).not.toContain("[class*='title' i]");
  });

  test("mod-right move is viewport-anchored with auto box, never display:none", async () => {
    const css = await readText("../style.css");
    const ruleStart = css.indexOf(".titlebar-button-container.mod-right {");
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    const rule = css.slice(ruleStart, css.indexOf("}", ruleStart));
    for (const decl of [
      "position: fixed !important",
      // Visual lamps stay anchored: the 24px hit container is pulled back by
      // inset (default 5px) so the centered 14px lamp never shifts.
      "left: calc(var(--th-traffic-left) - var(--th-traffic-inset, 5px)) !important",
      "top: calc(var(--th-traffic-top) - var(--th-traffic-inset, 5px)) !important",
      "right: auto !important",
      "width: auto !important",
      "height: auto !important",
      "transform: none !important",
      "justify-content: flex-start !important",
      "gap: 0 !important",
      "padding-left: 0 !important",
      "pointer-events: auto !important",
    ]) {
      expect(rule).toContain(decl);
    }
    expect(rule).not.toContain("display: none");
    expect(rule).not.toContain("display:none");
  });

  test("hidden-frameless avoidance flows through Obsidian frame-space variables", async () => {
    // The visible top-left icons live in the workspace tab strip under the
    // transparent titlebar overlay. Instead of hardcoding padding per tab
    // container, the plugin overrides Obsidian's native --frame-left-space /
    // --frame-right-space on Windows/Linux so app.css avoids the lamps
    // itself (left padding + no-drag strips all consume the variables).
    // Folded (0,2,1): body.is-hidden-frameless:is(.mod-windows, .mod-linux).
    const css = stripCssComments(await readText("../style.css"));
    expect(css).toContain("body.is-hidden-frameless:is(.mod-windows, .mod-linux)");
    const idx = css.indexOf("body.is-hidden-frameless:is(");
    const block = css.slice(idx, css.indexOf("}", idx));
    expect(block).toContain("--frame-left-space: var(--th-traffic-reserved, 76px) !important");
    expect(block).toContain("--frame-right-space: 0px !important");
    // No hardcoded per-container push-aside remains: the variable override
    // subsumes it (identical computed value, follows mod-top-left-space).
    expect(css).not.toContain("mod-top-left-space .workspace-tab-header-container");
    expect(css).not.toContain(".mod-left-split .workspace-tab-header-container");
  });

  test("macOS frame space is never overridden (native lights left alone)", async () => {
    // Obsidian reserves 80px for native macOS traffic lights; the plugin
    // must not touch that platform path.
    const css = stripCssComments(await readText("../style.css"));
    expect(css).not.toContain("mod-macos");
    expect(css).not.toContain("--frame-right-space: 126px");
  });
});

describe("traffic hit-box contract (24x24 cells, 14px lamps, host-overlay parity)", () => {
  test(":root derives cell-size and inset with 14/10/24/5 defaults", async () => {
    const css = await readText("../style.css");
    const stripped = stripCssComments(css);
    const rootStart = stripped.indexOf(":root {");
    expect(rootStart).toBeGreaterThanOrEqual(0);
    const root = stripped.slice(rootStart, stripped.indexOf("}", rootStart));
    // Public tunables stay valid: size = lamp diameter, gap = visual edge gap.
    expect(root).toContain("--th-traffic-size: 14px");
    expect(root).toContain("--th-traffic-gap: 10px");
    expect(root).toContain("--th-traffic-left: 12px");
    expect(root).toContain("--th-traffic-top: 12px");
    // Derived: cell-size = size + gap, inset = gap / 2.
    expect(root).toContain("--th-traffic-cell-size");
    expect(root).toContain("var(--th-traffic-size)");
    expect(root).toContain("var(--th-traffic-gap)");
    expect(root).toContain("--th-traffic-inset");
    expect(root).toContain("/ 2");
    // Defaults compute to cell 24 (14+10), lamp 14, inset 5 (10/2).
    expect(css).toContain("--th-traffic-cell-size, 24px");
    expect(css).toContain("var(--th-traffic-size, 14px)");
    expect(css).toContain("var(--th-traffic-inset, 5px)");
    // No cell alias: exactly cell-size + inset are derived (the ":"
    // distinguishes the alias from "--th-traffic-cell-size:").
    expect(root).not.toContain("--th-traffic-cell:");
  });

  test("relocated containers use adjacent cells: gap 0 and inset-compensated anchors", async () => {
    const css = stripCssComments(await readText("../style.css"));
    // No 10px dead zone remains between lamps: every transport group packs
    // its 24px cells with gap 0 (pitch = cell = size + gap = 24).
    expect(css).not.toContain("gap: var(--th-traffic-gap)");
    const gapZeroCount = (css.match(/gap:\s*0\s*!important/g) ?? []).length;
    expect(gapZeroCount).toBeGreaterThanOrEqual(5);
    // Visual lamps stay put: each container anchor subtracts the inset so
    // the centered lamp does not drift 5px down-right.
    expect(css).toContain("calc(var(--th-traffic-left) - var(--th-traffic-inset, 5px))");
    expect(css).toContain("calc(var(--th-traffic-top) - var(--th-traffic-inset, 5px))");
  });

  test("shared button rule is a transparent rectangular hit cell, no longer 14x14", async () => {
    const css = await readText("../style.css");
    const stripped = stripCssComments(css);
    // Folded tiers: B1 :is(C) button (0,1,1) / B2 :is(C) [role=button]
    // (0,2,0) / D :is(winButtons-child, winButton) (0,1,0) / O alone.
    const hitStart = stripped.indexOf(") button,");
    expect(hitStart).toBeGreaterThanOrEqual(0);
    const rule = stripped.slice(hitStart, stripped.indexOf("}", hitStart));
    for (const decl of [
      "width: var(--th-traffic-cell-size, 24px) !important",
      "height: var(--th-traffic-cell-size, 24px) !important",
      "min-width: var(--th-traffic-cell-size, 24px) !important",
      "min-height: var(--th-traffic-cell-size, 24px) !important",
      "max-width: var(--th-traffic-cell-size, 24px) !important",
      "max-height: var(--th-traffic-cell-size, 24px) !important",
      "background: transparent !important",
      "border: 0 !important",
      "border-radius: 0 !important",
      "box-shadow: none !important",
      "position: relative !important",
      "pointer-events: auto !important",
      "-webkit-app-region: no-drag !important",
    ]) {
      expect(rule).toContain(decl);
    }
    // The old 14x14 clickable box is gone from the button itself.
    expect(rule).not.toContain("width: var(--th-traffic-size)");
    expect(rule).not.toContain("border-radius: 50%");
    // Never shrink the hit-test back to a circle: scoped to the hit-cell
    // rule only (comments/docs elsewhere may mention the term).
    expect(rule.replace(/never clip-path\/mask it back to a/g, "")).not.toContain("clip-path");
    expect(rule).not.toContain("mask-image");
  });

  test("::before draws the lamp with the same selector list, centered and click-through", async () => {
    const css = await readText("../style.css");
    const stripped = stripCssComments(css);
    // Folded tiers (same as the hit cell, plus ::before).
    for (const sel of [
      ") button::before",
      '[role="button"]::before',
      '[class*="winButtons" i] > *, [class*="winButton" i])::before',
      ".titlebar-button-container.mod-right .titlebar-button::before",
      // C roots all share one :is() per tier.
      '.window-control, [class*="window-controls" i]',
      '[class*="windowControls" i]',
      '[class*="titlebar__controls" i]',
      ".caption-buttons, .captionButtons",
      ".frameless-controls, .header-controls",
    ]) {
      expect(stripped).toContain(sel);
    }
    // No redundant exact duplicates in the folded structure tiers:
    // .window-controls exact is covered by the window-controls substring,
    // p-titlebar is a subset of titlebar__controls.
    expect(stripped).not.toContain(".window-controls button::before");
    expect(stripped).not.toContain('[class*="p-titlebar__controls" i] button::before');
    const beforeStart = stripped.indexOf(") button::before,");
    expect(beforeStart).toBeGreaterThanOrEqual(0);
    const before = stripped.slice(beforeStart, stripped.indexOf("}", beforeStart));
    for (const decl of [
      'content: "" !important',
      "position: absolute !important",
      "left: 50% !important",
      "top: 50% !important",
      "translate(-50%, -50%)",
      "width: var(--th-traffic-size, 14px) !important",
      "height: var(--th-traffic-size, 14px) !important",
      "box-sizing: border-box !important",
      "border-radius: 50% !important",
      "background: var(--th-traffic-lamp-fill, #e0e0e0) !important",
      "pointer-events: none !important",
    ]) {
      expect(before).toContain(decl);
    }
    expect(before).toContain("var(--th-traffic-lamp-stroke");
  });

  test("semantic and positional rules tint the lamp variable, never the hit box", async () => {
    const stripped = stripCssComments(await readText("../style.css"));
    // Lamp variables carry the default gray plus close/min/max colors.
    for (const decl of [
      "--th-traffic-lamp-fill: #ff5f57 !important",
      "--th-traffic-lamp-stroke: #e0443e !important",
      "--th-traffic-lamp-fill: #febc2e !important",
      "--th-traffic-lamp-stroke: #de9f22 !important",
      "--th-traffic-lamp-fill: #28c840 !important",
      "--th-traffic-lamp-stroke: #1dad2b !important",
    ]) {
      expect(stripped).toContain(decl);
    }
    // The 24px hit box itself is never painted: scoped to the hit-cell rule
    // only, so future unrelated styles cannot fail this contract.
    const hitStart = stripped.indexOf(") button,");
    expect(hitStart).toBeGreaterThanOrEqual(0);
    const hitRule = stripped.slice(hitStart, stripped.indexOf("}", hitStart));
    expect(hitRule).not.toContain("background: #ff5f57");
    expect(hitRule).not.toContain("background: #febc2e");
    expect(hitRule).not.toContain("background: #28c840");
    expect(hitRule).not.toContain("background: #e0e0e0");
    expect(hitRule).not.toContain("border-color: #e0443e");
    expect(hitRule).not.toContain("border-color: #de9f22");
    expect(hitRule).not.toContain("border-color: #1dad2b");
    // Order (macOS [close, min, max]) is still enforced.
    expect(stripped).toContain("order: 1 !important");
    expect(stripped).toContain("order: 2 !important");
    expect(stripped).toContain("order: 3 !important");
  });

  test("hover glyph layer is absolutely centered and click-through; active still dims", async () => {
    const stripped = stripCssComments(await readText("../style.css"));
    const afterStart = stripped.indexOf(") button::after,");
    expect(afterStart).toBeGreaterThanOrEqual(0);
    const after = stripped.slice(afterStart, stripped.indexOf("}", afterStart));
    for (const decl of [
      "position: absolute !important",
      "left: 50% !important",
      "top: 50% !important",
      "translate(-50%, -50%)",
      "pointer-events: none !important",
      'content: "" !important',
    ]) {
      expect(after).toContain(decl);
    }
    expect(stripped).toContain(":hover::after");
    expect(stripped).toContain("opacity: 1 !important");
    // Active press still darkens the lamp.
    expect(stripped).toContain(":active");
    expect(stripped).toContain("filter: brightness(0.85) !important");
    // Buttons stay draggable-never: titlebar drags, lamps opt out.
    expect(stripped).toContain("-webkit-app-region: no-drag !important");
  });

  test("focus outline wraps the visual lamp; dark/light shadows live on ::before", async () => {
    const stripped = stripCssComments(await readText("../style.css"));
    // Focus-visible never outlines the 24px hit cell itself.
    expect(stripped).toContain(":focus-visible::before");
    const focusBeforeStart = stripped.indexOf("button:focus-visible::before,");
    expect(focusBeforeStart).toBeGreaterThanOrEqual(0);
    const focusBefore = stripped.slice(focusBeforeStart, stripped.indexOf("}", focusBeforeStart));
    expect(focusBefore).toContain("outline: 2px solid #0a84ff !important");
    expect(focusBefore).toContain("outline-offset: 2px !important");
    // Dark/light adaptation targets the lamp, not the hit box.
    const darkStart = stripped.indexOf("@media (prefers-color-scheme: dark)");
    expect(darkStart).toBeGreaterThanOrEqual(0);
    const dark = stripped.slice(darkStart, stripped.indexOf("}", stripped.indexOf("}", darkStart) + 1) + 1);
    expect(dark).toContain("::before");
    expect(dark).toContain("box-shadow:");
    const lightStart = stripped.indexOf("@media (prefers-color-scheme: light)");
    expect(lightStart).toBeGreaterThanOrEqual(0);
    const light = stripped.slice(lightStart, stripped.indexOf("}", stripped.indexOf("}", lightStart) + 1) + 1);
    expect(light).toContain("::before");
    expect(light).toContain("box-shadow:");
  });

  test("supported cluster closure: no gap:0 container without a full button chain", async () => {
    // Acceptance: no static counterexample where a container is relocated
    // with gap:0 + inset compensation but its buttons keep native size with
    // no lamp pseudo-element. Structure tiers are folded with :is() so the
    // assertions check tier tokens, not per-cluster expanded selectors:
    // C roots share one :is(), D folds winButtons-child + winButton, O stays
    // alone. Detection (renderer selector) still lists every cluster.
    const css = await readText("../style.css");
    const stripped = stripCssComments(css);
    // Single source: detection lives in src/renderer.js only.
    const src = await readText("./renderer.js");
    const pickSelector = (text: string): string => {
      const block = text.slice(text.indexOf("WINDOW_CONTROL_SELECTOR"));
      const end = block.indexOf(";");
      if (end < 0) throw new Error("WINDOW_CONTROL_SELECTOR not found");
      const decl = block.slice(0, end);
      // Join every string literal (both "..." and '...') in declaration order.
      const parts: string[] = [];
      const re = /"([^"]*)"|'([^']*)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(decl)) !== null) {
        parts.push(m[1] ?? m[2] ?? "");
      }
      if (parts.length === 0) throw new Error("WINDOW_CONTROL_SELECTOR not found");
      return parts.join("");
    };
    const selector = pickSelector(src);
    expect(selector.length).toBeGreaterThan(0);

    // Detection covers every moved container (closed matrix: precise
    // container tokens only, never bare buttons).
    for (const token of [
      ".window-controls",
      ".window-controls-container",
      ".window-control",
      '[class*="window-controls" i]',
      '[class*="windowControls" i]',
      '[class*="winButtons" i]',
      '[class*="p-titlebar__controls" i]',
      '[class*="titlebar__controls" i]',
      ".caption-buttons",
      ".captionButtons",
      ".frameless-controls",
      ".header-controls",
      ".titlebar-button-container.mod-right",
    ]) {
      expect(selector).toContain(token);
    }
    // Bare buttons must not suppress the overlay: Obsidian moves only the
    // precise container, Discord moves div[winButtons] only.
    expect(selector).not.toContain('[class*="winButton" i]');
    expect(selector).not.toContain(".titlebar-button.mod-minimize");
    expect(selector).not.toContain(".titlebar-button.mod-maximize");
    expect(selector).not.toContain(".titlebar-button.mod-close");

    // Folded C tier token shared by every structure layer.
    const cTier =
      '.window-control, [class*="window-controls" i], [class*="windowControls" i], [class*="titlebar__controls" i], .caption-buttons, .captionButtons, .frameless-controls, .header-controls';
    const dTier = '[class*="winButtons" i] > *, [class*="winButton" i]';
    const oCell = ".titlebar-button-container.mod-right .titlebar-button";
    // Every key layer carries the same folded tiers.
    for (const fragment of [
      `${cTier}) button,`,
      `${cTier}) button::before,`,
      `${cTier}) button::after,`,
      `${cTier}) button:active,`,
      `${cTier}) button:focus-visible,`,
      `${cTier}) button:focus-visible::before,`,
      `${dTier})::before,`,
      `${dTier})::after,`,
      `${dTier}):active,`,
      `${dTier}):focus-visible,`,
      `${oCell} {`,
      `${oCell}::before {`,
      `${oCell}::after {`,
      `${oCell}:active {`,
      `${oCell}:focus-visible {`,
      `${oCell}:focus-visible::before {`,
    ]) {
      expect(stripped).toContain(fragment);
    }
    // Redundant structure duplicates are folded away, never duplicated.
    expect(stripped).not.toContain(".window-controls button,");
    expect(stripped).not.toContain(".window-controls-container button,");
    expect(stripped).not.toContain('[class*="p-titlebar__controls" i] button,');

    // Theme layers carry the folded lamp tiers.
    const darkStart = stripped.indexOf("@media (prefers-color-scheme: dark)");
    expect(darkStart).toBeGreaterThanOrEqual(0);
    const darkEnd = stripped.indexOf("}", stripped.indexOf("}", darkStart) + 1) + 1;
    const dark = stripped.slice(darkStart, darkEnd);
    expect(dark).toContain(") button::before,");
    expect(dark).toContain(`${dTier})::before,`);
    expect(dark).toContain(`${oCell}::before`);
    const lightStart = stripped.indexOf("@media (prefers-color-scheme: light)");
    expect(lightStart).toBeGreaterThanOrEqual(0);
    const lightEnd = stripped.indexOf("}", stripped.indexOf("}", lightStart) + 1) + 1;
    const light = stripped.slice(lightStart, lightEnd);
    expect(light).toContain(") button::before,");
    expect(light).toContain(`${dTier})::before,`);
    expect(light).toContain(`${oCell}::before`);
  });

  test("semantic colors, hover glyphs and icon hiding cover every supported cluster", async () => {
    // Oracle re-review gate: positional fallbacks alone mis-tint macOS-order
    // clusters that DO carry aria semantics (e.g. a frameless first child
    // labelled Close would otherwise paint yellow by position). Every moved
    // cluster therefore needs aria-keyed lamp colors AND hover glyphs, plus
    // icon hiding for svg/img/span descendants. Folded tiers: S colors fold
    // aria per action inside :is(), G glyphs mirror S + :hover::after,
    // I icons fold svg/img/span. Whitespace-flattened matching keeps the
    // assertions on selector presence, not formatting.
    const stripped = stripCssComments(await readText("../style.css"));
    const flat = stripped.replace(/\s+/g, "");
    // C tier token (flattened: space before i] drops).
    const cFlat =
      '.window-control,[class*="window-controls"i],[class*="windowControls"i],[class*="titlebar__controls"i],.caption-buttons,.captionButtons,.frameless-controls,.header-controls';
    expect(flat).toContain(cFlat);
    // S colors per action: generic C folds aria/title per action inside one
    // inner :is() per tier — B1 button first, B2 [role=button] second, never
    // merged (tiers stay (0,2,1)/(0,3,0)). Close B1 adds data-action/class,
    // Min/Max B1 add class; title Restor is covered (green).
    expect(flat).toContain(`(${cFlat})button:is([aria-label*="Close"i],[title*="Close"i],[data-action*="close"i],[class*="close"i])`);
    expect(flat).toContain(`(${cFlat})button:is([aria-label*="Minimiz"i],[title*="Minimiz"i],[class*="minimiz"i])`);
    expect(flat).toContain(`(${cFlat})button:is([aria-label*="Maximiz"i],[aria-label*="Restor"i],[title*="Maximiz"i],[title*="Restor"i],[class*="maximiz"i])`);
    expect(flat).toContain(`(${cFlat})[role="button"]:is([aria-label*="Close"i],[title*="Close"i])`);
    expect(flat).toContain(`(${cFlat})[role="button"]:is([aria-label*="Minimiz"i],[title*="Minimiz"i])`);
    expect(flat).toContain(`(${cFlat})[role="button"]:is([aria-label*="Maximiz"i],[aria-label*="Restor"i],[title*="Maximiz"i],[title*="Restor"i])`);
    // Old narrow branches are gone: title/data-action/global-class now live
    // only inside the C-tier folds above (C covers every moved root).
    expect(flat).not.toContain(':is(.window-controls,.window-controls-container)button[title*=');
    expect(flat).not.toContain('.window-controlsbutton[data-action*=');
    expect(flat).not.toContain('button[class*="close"i],');
    expect(flat).not.toContain('button[class*="minimiz"i],');
    expect(flat).not.toContain('button[class*="minimize"i]');
    expect(flat).not.toContain('button[class*="maximiz"i],');
    // G glyphs mirror S condition-for-condition + :hover::after (order
    // specials stay expanded). Both B1 button and B2 [role=button] hover
    // paths fold the SAME per-action sets as S (title/data/class included),
    // so every semantically painted lamp also shows its ×/–/+ glyph.
    expect(flat).toContain(`(${cFlat})button:is([aria-label*="Close"i],[title*="Close"i],[data-action*="close"i],[class*="close"i]):hover::after`);
    expect(flat).toContain(`(${cFlat})button:is([aria-label*="Minimiz"i],[title*="Minimiz"i],[class*="minimiz"i]):hover::after`);
    expect(flat).toContain(`(${cFlat})button:is([aria-label*="Maximiz"i],[aria-label*="Restor"i],[title*="Maximiz"i],[title*="Restor"i],[class*="maximiz"i]):hover::after`);
    expect(flat).toContain(`(${cFlat})[role="button"]:is([aria-label*="Close"i],[title*="Close"i]):hover::after`);
    expect(flat).toContain(`(${cFlat})[role="button"]:is([aria-label*="Minimiz"i],[title*="Minimiz"i]):hover::after`);
    expect(flat).toContain(`(${cFlat})[role="button"]:is([aria-label*="Maximiz"i],[aria-label*="Restor"i],[title*="Maximiz"i],[title*="Restor"i]):hover::after`);
    expect(flat).toContain('.window-controlsbutton[style*="order:1"]::after');
    expect(flat).toContain('.window-controlsbutton[order="1"]::after');
    // I icons: button + role subtrees fold inner svg/img/span.
    expect(flat).toContain(`(${cFlat})button:is(svg,img,span)`);
    expect(flat).toContain(`(${cFlat})[role="button"]:is(svg,img,span)`);
    expect(flat).toContain('[class*="winButtons"i]:is(img,span)');
    // Discord aria per action (Max folds Maximiz+Restor children).
    for (const a of ["Close", "Minimiz"]) {
      expect(flat).toContain(`[class*="winButton"i][aria-label*="${a}"i],[class*="winButtons"i]>*[aria-label*="${a}"i]`);
      expect(flat).toContain(`[class*="winButton"i][aria-label*="${a}"i],[class*="winButtons"i]>*[aria-label*="${a}"i]):hover::after`);
    }
    expect(flat).toContain('[class*="winButton"i][aria-label*="Maximiz"i],[class*="winButtons"i]>*[aria-label*="Maximiz"i],[class*="winButtons"i]>*[aria-label*="Restor"i]');
    expect(flat).toContain('[class*="winButton"i][aria-label*="Maximiz"i],[class*="winButtons"i]>*[aria-label*="Maximiz"i],[class*="winButtons"i]>*[aria-label*="Restor"i]):hover::after');
    // Obsidian internal folds keep Chinese labels (colors + glyphs).
    for (const zh of ["关闭", "最小化", "最大化", "还原", "向下还原"]) {
      expect(stripped).toContain(zh);
    }
    expect(flat).toContain('.titlebar-button-container.mod-right.titlebar-button:is(.mod-close,');
    expect(flat).toContain('.titlebar-button-container.mod-right.titlebar-button:is(.mod-minimize,');
    expect(flat).toContain('.titlebar-button-container.mod-right.titlebar-button:is(.mod-maximize,');
  });

  test("C role semantics reuse the button declarations (S colors + G glyphs)", async () => {
    // MUST-FIX 1: B2 [role=button] carries the same lamp vars/order/SVG as
    // B1 button per action, as separate selectors in the SAME rule (shared
    // declaration body, tiers unchanged: B1 stays :is(C) button, B2 stays
    // :is(C) [role=button], never merged into one :is).
    const stripped = stripCssComments(await readText("../style.css"));
    const ruleOf = (anchor: string): string => {
      const i = stripped.indexOf(anchor);
      expect(i).toBeGreaterThanOrEqual(0);
      return stripped.slice(i, stripped.indexOf("}", i));
    };
    // Close (red, order 1): role selector shares the button rule body.
    const closeRule = ruleOf('button:is([aria-label*="Close" i],');
    expect(closeRule).toContain('[role="button"]:is([aria-label*="Close" i], [title*="Close" i])');
    expect(closeRule).toContain("--th-traffic-lamp-fill: #ff5f57 !important");
    expect(closeRule).toContain("--th-traffic-lamp-stroke: #e0443e !important");
    expect(closeRule).toContain("order: 1 !important");
    // Minimize (yellow, order 2).
    const minRule = ruleOf('button:is([aria-label*="Minimiz" i],');
    expect(minRule).toContain('[role="button"]:is([aria-label*="Minimiz" i], [title*="Minimiz" i])');
    expect(minRule).toContain("--th-traffic-lamp-fill: #febc2e !important");
    expect(minRule).toContain("--th-traffic-lamp-stroke: #de9f22 !important");
    expect(minRule).toContain("order: 2 !important");
    // Maximize/Restore (green, order 3): inner :is fold mirrored for role.
    const maxRule = ruleOf('button:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i],');
    expect(maxRule).toContain('[role="button"]:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i], [title*="Restor" i])');
    expect(maxRule).toContain("--th-traffic-lamp-fill: #28c840 !important");
    expect(maxRule).toContain("--th-traffic-lamp-stroke: #1dad2b !important");
    expect(maxRule).toContain("order: 3 !important");
    // Glyphs: each role hover selector shares its button glyph rule (same
    // SVG declaration body), so role lamps show ×/–/+ on hover too.
    const closeGlyph = ruleOf('button:is([aria-label*="Close" i], [title*="Close" i], [data-action*="close" i], [class*="close" i]):hover::after,');
    expect(closeGlyph).toContain('[role="button"]:is([aria-label*="Close" i], [title*="Close" i]):hover::after');
    expect(closeGlyph).toContain("background-image: url(\"data:image/svg+xml,");
    const minGlyph = ruleOf('button:is([aria-label*="Minimiz" i], [title*="Minimiz" i], [class*="minimiz" i]):hover::after,');
    expect(minGlyph).toContain('[role="button"]:is([aria-label*="Minimiz" i], [title*="Minimiz" i]):hover::after');
    expect(minGlyph).toContain("background-image: url(\"data:image/svg+xml,");
    const maxGlyph = ruleOf('button:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i], [title*="Restor" i], [class*="maximiz" i]):hover::after,');
    expect(maxGlyph).toContain('[role="button"]:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i], [title*="Restor" i]):hover::after');
    expect(maxGlyph).toContain("background-image: url(\"data:image/svg+xml,");
    // S tiers stay separate: each S rule lists B1 and B2 as DISTINCT comma
    // selectors (never one merged :is(button, [role=button]) tier). The
    // merged form is allowed ONLY inside zero-specificity P :not(:where())
    // guards, which are spaceless; S style keeps the space.
    const selectorsOf = (anchor: string): string => {
      const i = stripped.indexOf(anchor);
      expect(i).toBeGreaterThanOrEqual(0);
      const start = stripped.lastIndexOf("}", i) + 1;
      return stripped.slice(start, stripped.indexOf("{", i));
    };
    for (const anchor of [
      'button:is([aria-label*="Close" i],',
      'button:is([aria-label*="Minimiz" i],',
      'button:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i],',
    ]) {
      const sels = selectorsOf(anchor);
      expect(sels).toContain('[role="button"]:is(');
      expect(sels).not.toContain(":is(button, ");
    }
  });

  test("generic G folds mirror the S folds per action per tier", async () => {
    // G-mirrors-S contract: each of the six S condition folds must reappear
    // EXACTLY once as a :hover::after fold emitting the same action glyph —
    // otherwise a semantically painted lamp (title/data-action/class, role
    // title included) hovers with opacity but no background-image. Locks
    // title Close, title Restore, role title, and data-action/class glyphs.
    const stripped = stripCssComments(await readText("../style.css"));
    const cTier =
      ':is(.window-control, [class*="window-controls" i], [class*="windowControls" i], [class*="titlebar__controls" i], .caption-buttons, .captionButtons, .frameless-controls, .header-controls)';
    const folds = [
      'button:is([aria-label*="Close" i], [title*="Close" i], [data-action*="close" i], [class*="close" i])',
      '[role="button"]:is([aria-label*="Close" i], [title*="Close" i])',
      'button:is([aria-label*="Minimiz" i], [title*="Minimiz" i], [class*="minimiz" i])',
      '[role="button"]:is([aria-label*="Minimiz" i], [title*="Minimiz" i])',
      'button:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i], [title*="Restor" i], [class*="maximiz" i])',
      '[role="button"]:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i], [title*="Restor" i])',
    ];
    for (const f of folds) {
      // Once as an S selector (plain, comma-terminated)...
      expect(stripped).toContain(`${cTier} ${f},`);
      // ...and once as a G selector (same fold + :hover::after).
      expect(stripped).toContain(`${cTier} ${f}:hover::after,`);
      // Exactly those two occurrences: replaced, never appended alongside
      // a stale aria-only twin.
      expect(stripped.split(`${cTier} ${f}`).length).toBe(3);
    }
    // No stale aria-only generic G survivors (Discord G untouched).
    expect(stripped).not.toContain('button[aria-label*="Close" i]:hover::after');
    expect(stripped).not.toContain('button[aria-label*="Minimiz" i]:hover::after');
    expect(stripped).not.toContain('[role="button"][aria-label*="Close" i]:hover::after');
    expect(stripped).not.toContain('[role="button"][aria-label*="Minimiz" i]:hover::after');
  });

  test("obsidian G folds mirror the S folds per action", async () => {
    // Same contract as generic: each Obsidian S inner fold (mod + Chinese/
    // English aria AND title) reappears exactly once as a :hover::after
    // fold, so title-only Obsidian buttons (e.g. [title="关闭"]) show the
    // ×/–/+ glyph instead of hovering glyph-less at opacity 1.
    const stripped = stripCssComments(await readText("../style.css"));
    const oCell = ".titlebar-button-container.mod-right .titlebar-button:is(";
    const folds = [
      '.mod-close, [aria-label*="Close" i], [aria-label*="关闭" i], [title*="Close" i], [title*="关闭" i])',
      '.mod-minimize, [aria-label*="Minimiz" i], [aria-label*="最小化" i], [title*="Minimiz" i], [title*="最小化" i])',
      '.mod-maximize, [aria-label*="Maximiz" i], [aria-label*="Restor" i], [aria-label*="最大化" i], [aria-label*="还原" i], [aria-label*="向下还原" i], [title*="Maximiz" i], [title*="Restor" i], [title*="最大化" i], [title*="还原" i], [title*="向下还原" i])',
    ];
    for (const f of folds) {
      // Once as an S selector (comma- or brace-terminated)...
      expect(stripped).toContain(`${oCell}${f}`);
      // ...and once as a G selector (same fold + :hover::after).
      expect(stripped).toContain(`${oCell}${f}:hover::after`);
      // Exactly those two occurrences: replaced, never appended.
      expect(stripped.split(`${oCell}${f}`).length).toBe(3);
    }
    // Title-only buttons resolve to glyph rules: the title conditions sit
    // inside :hover::after folds, not just S color folds.
    for (const t of ['[title*="关闭" i]):hover::after', '[title*="最小化" i]):hover::after', '[title*="还原" i], [title*="向下还原" i]):hover::after']) {
      expect(stripped).toContain(t);
    }
  });

  test("positional fallbacks carry zero-specificity semantic guards", async () => {
    // MUST-FIX 1: generic S is usually (0,2,1) while generic P is (0,3,0)
    // and later, so without a guard a macOS-order cluster WITH semantics
    // would lose to position. Every P selector therefore excludes supported
    // semantics via :not(:where(...)) — zero specificity, tiers unchanged —
    // so semantic rules win and plain Windows order still reorders/paints.
    const stripped = stripCssComments(await readText("../style.css"));
    const flat = stripped.replace(/\s+/g, "");
    // 12 P guards total: 3 reorder x (generic + obsidian) + 3 paints x 2.
    const guardCount = (flat.match(/:not\(:where\(/g) ?? []).length;
    expect(guardCount).toBe(12);
    // Guards never smuggle specificity: no :not(:is( anywhere in P.
    expect(flat).not.toContain(":not(:is(");
    // Generic reorder keeps its original Close :not (specificity preserved)
    // and appends the zero-specificity full-semantic guard.
    for (const n of [1, 2, 3]) {
      expect(flat).toContain(`>:nth-child(${n}):not([aria-label*="Close"i]):not(:where(`);
    }
    const guards = flat.match(/:not\(:where\(.*?\)\)/g) ?? [];
    expect(guards.length).toBe(12);
    // Generic guard mirrors the S compounds EXACTLY (merged zero-spec form):
    // group 1 shares aria/title across button+role (both B1 and B2 cover
    // them); group 2 is button-only data-action/class (B1 Close/Min/Max
    // only — B2 has no data/class S, so role+data/class stays positional).
    // All six generic guards are byte-identical to this contract string.
    const genericGuard =
      ':not(:where(:is(button,[role="button"])' +
      ':is([aria-label*="Close"i],[aria-label*="Minimiz"i],' +
      '[aria-label*="Maximiz"i],[aria-label*="Restor"i],' +
      '[title*="Close"i],[title*="Minimiz"i],' +
      '[title*="Maximiz"i],[title*="Restor"i]),' +
      'button:is([data-action*="close"i],[class*="close"i],' +
      '[class*="minimiz"i],[class*="maximiz"i])))';
    const genericGuards = guards.filter((g) => g.includes('[data-action*="close"i]'));
    expect(genericGuards.length).toBe(6);
    for (const g of genericGuards) {
      expect(g).toBe(genericGuard.slice(0, -1));
    }
    // No over-exclusion: role never pairs with data-action/class in the
    // guard (B2 has no such S), and no bare unattributed element guard.
    expect(genericGuard).not.toContain('[role="button"][data-action');
    expect(genericGuard).not.toContain('[role="button"][class');
    expect(genericGuard).not.toContain('[role="button"]:is([data-action');
    // Every generic positional paint carries the guard (never bare). The
    // `.header-controls)` prefix pins the generic :is(C) selector itself,
    // so these cannot pass vacuously via the Obsidian selectors below.
    expect(flat).toContain(".header-controls)>:nth-child(3):last-child:not(:where(");
    expect(flat).toContain(".header-controls)>:nth-child(1):first-child:not(:where(");
    expect(flat).toContain(".header-controls)>:nth-child(2):nth-last-child(2):not(:where(");
    expect(flat).not.toContain(".header-controls)>:nth-child(3):last-child,");
    expect(flat).not.toContain(".header-controls)>:nth-child(3):last-child{");
    expect(flat).not.toContain(".header-controls)>:nth-child(1):first-child,");
    expect(flat).not.toContain(".header-controls)>:nth-child(1):first-child{");
    expect(flat).not.toContain(".header-controls)>:nth-child(2):nth-last-child(2),");
    expect(flat).not.toContain(".header-controls)>:nth-child(2):nth-last-child(2){");
    // Obsidian reorder keeps its Close guards and appends the mod/aria/title
    // guard; every Obsidian paint carries the same guard.
    const obsidianGuards = guards.filter((g) => g.includes(".mod-close"));
    expect(obsidianGuards.length).toBe(6);
    for (const g of obsidianGuards) {
      for (const token of [
        ".mod-close",
        ".mod-minimize",
        ".mod-maximize",
        '[aria-label*="Close"i]',
        '[aria-label*="Minimiz"i]',
        '[aria-label*="Maximiz"i]',
        '[aria-label*="Restor"i]',
        '[title*="Close"i]',
        '[title*="Minimiz"i]',
        '[title*="Maximiz"i]',
        '[title*="Restor"i]',
      ]) {
        expect(g).toContain(token);
      }
    }
    for (const zh of ["关闭", "最小化", "最大化", "还原", "向下还原"]) {
      expect(flat).toContain(zh);
      expect(obsidianGuards.join("")).toContain(zh);
    }
    expect(flat).toContain(".titlebar-button-container.mod-right>:nth-child(3):last-child:not(:where(");
    expect(flat).toContain(".titlebar-button-container.mod-right>:nth-child(1):first-child:not(:where(");
    expect(flat).toContain(".titlebar-button-container.mod-right>:nth-child(2):nth-last-child(2):not(:where(");
    expect(flat).not.toContain(".titlebar-button-container.mod-right>:nth-child(3):last-child{");
    expect(flat).not.toContain(".titlebar-button-container.mod-right>:nth-child(1):first-child{");
    expect(flat).not.toContain(".titlebar-button-container.mod-right>:nth-child(2):nth-last-child(2){");
    // Every Obsidian reorder keeps its original Close guards (specificity
    // preserved) and appends the zero-specificity mod/aria/title guard.
    for (const n of [1, 2, 3]) {
      expect(flat).toContain(
        `.titlebar-button-container.mod-right>:nth-child(${n}):not([aria-label*="Close"i]):not([aria-label*="关闭"i]):not(.mod-close):not(:where(`,
      );
    }
    // Cascade contract: S rules stay before P in the stylesheet, so with
    // guards excluding semantics, plain Windows order still maps nth1->2 /
    // nth2->3 / nth3->1 while semantic clusters fall to S colors. Anchored
    // on selectors (not comment markers): S color fold, P reorder fold,
    // P paint fold.
    const sIdx = stripped.indexOf('button:is([aria-label*="Close" i],');
    const pReorderIdx = stripped.indexOf('> :nth-child(1):not([aria-label*="');
    const pPaintIdx = stripped.indexOf("> :nth-child(3):last-child:not(:where(");
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(pReorderIdx).toBeGreaterThanOrEqual(0);
    expect(pPaintIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeLessThan(pReorderIdx);
    expect(pReorderIdx).toBeLessThan(pPaintIdx);
    expect(stripped).toContain("order: 2 !important");
    expect(stripped).toContain("order: 3 !important");
    expect(stripped).toContain("order: 1 !important");
  });

  test("guard-excluded generic compounds all resolve to a B1/B2 S rule", async () => {
    // Matrix closure: EVERY compound the generic P guard excludes must win
    // an S rule — otherwise the element is positionally skipped AND
    // semantically unpainted (gray lamp, no semantic order). Locks the four
    // known gray-hole DOMs plus the full guard↔S mapping, in both tiers and
    // at C scope (so .header-controls children are covered, not just
    // .window-controls ones).
    const stripped = stripCssComments(await readText("../style.css"));
    const sRule = (anchor: string): string => {
      const i = stripped.indexOf(anchor);
      expect(i).toBeGreaterThanOrEqual(0);
      return stripped.slice(i, stripped.indexOf("}", i));
    };
    // B1 S rules (C scope) and B2 S rules, joined per tier for mapping.
    const b1Close = sRule('button:is([aria-label*="Close" i],');
    const b1Min = sRule('button:is([aria-label*="Minimiz" i],');
    const b1Max = sRule('button:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i],');
    const b1 = b1Close + b1Min + b1Max;
    const b2Close = sRule('[role="button"]:is([aria-label*="Close" i], [title*="Close" i])');
    const b2Min = sRule('[role="button"]:is([aria-label*="Minimiz" i], [title*="Minimiz" i])');
    const b2Max = sRule('[role="button"]:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i], [title*="Restor" i])');
    const b2 = b2Close + b2Min + b2Max;
    // Every S fold above is C-scoped (covers .header-controls, not only
    // .window-controls): assert the full C-tier prefix ahead of each fold.
    const cTier =
      ':is(.window-control, [class*="window-controls" i], [class*="windowControls" i], [class*="titlebar__controls" i], .caption-buttons, .captionButtons, .frameless-controls, .header-controls)';
    for (const sel of [
      `${cTier} button:is([aria-label*="Close" i],`,
      `${cTier} button:is([aria-label*="Minimiz" i],`,
      `${cTier} button:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i],`,
      `${cTier} [role="button"]:is([aria-label*="Close" i], [title*="Close" i])`,
      `${cTier} [role="button"]:is([aria-label*="Minimiz" i], [title*="Minimiz" i])`,
      `${cTier} [role="button"]:is([aria-label*="Maximiz" i], [aria-label*="Restor" i], [title*="Maximiz" i], [title*="Restor" i])`,
    ]) {
      expect(stripped).toContain(sel);
    }
    // Counterexample 1: .header-controls > button[title="Close"] was gray
    // (title S only matched .window-controls). Now B1 Close + guard group 1.
    expect(b1Close).toContain('[title*="Close" i]');
    expect(b1Close).toContain("--th-traffic-lamp-fill: #ff5f57 !important");
    expect(b1Close).toContain("order: 1 !important");
    // Counterexample 2: button[title="Restore"] had no S at all. Now B1 Max
    // paints it green with max order.
    expect(b1Max).toContain('[title*="Restor" i]');
    expect(b1Max).toContain("--th-traffic-lamp-fill: #28c840 !important");
    expect(b1Max).toContain("order: 3 !important");
    // Counterexample 3: [role="button"][title="Close"] (title S was
    // button-only). Now B2 Close covers role+title.
    expect(b2Close).toContain('[title*="Close" i]');
    expect(b2Close).toContain("--th-traffic-lamp-fill: #ff5f57 !important");
    expect(b2Max).toContain('[title*="Restor" i]');
    // Counterexample 4: button[data-action="close"] outside .window-controls
    // (data-action S was .window-controls-scoped). Now B1 Close at C scope.
    expect(b1Close).toContain('[data-action*="close" i]');
    // Full mapping: every button-group guard compound resolves to B1 S,
    // every role-group compound to B2 S — none left gray.
    for (const item of [
      '[aria-label*="Close" i]',
      '[aria-label*="Minimiz" i]',
      '[aria-label*="Maximiz" i]',
      '[aria-label*="Restor" i]',
      '[title*="Close" i]',
      '[title*="Minimiz" i]',
      '[title*="Maximiz" i]',
      '[title*="Restor" i]',
    ]) {
      expect(b1).toContain(item);
      expect(b2).toContain(item);
    }
    for (const item of ['[data-action*="close" i]', '[class*="close" i]', '[class*="minimiz" i]', '[class*="maximiz" i]']) {
      expect(b1).toContain(item);
      expect(b2).not.toContain(item);
    }
  });

  test("wire size budgets: plan payload stays under the 64KB IPC frame cap", async () => {
    // Live verification is blocked when getExecutionPlan exceeds the host
    // 64KB IPC frame cap (~67KB payloads observed). Hard gates: style.css
    // alone <= 30KB; style.css + built renderer <= 40KB raw. The raw gate
    // reserves headroom for JSON escaping (which grows the payload) and the
    // IPC envelope; no GZIP applies on this path, so raw is the binding cap.
    const styleFile = Bun.file(`${import.meta.dir}/../style.css`);
    const styleBytes = (await styleFile.arrayBuffer()).byteLength;
    expect(styleBytes).toBeLessThanOrEqual(30720);
    let distBytes = 0;
    const distFile = Bun.file(`${import.meta.dir}/../dist/renderer.js`);
    if (await distFile.exists()) {
      distBytes = (await distFile.arrayBuffer()).byteLength;
    } else {
      const srcFile = Bun.file(`${import.meta.dir}/renderer.js`);
      distBytes = (await srcFile.arrayBuffer()).byteLength;
    }
    expect(styleBytes + distBytes).toBeLessThanOrEqual(40960);
  });
});
