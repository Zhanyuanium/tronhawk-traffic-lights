// Smoke + decorative-fallback tests for the traffic-lights renderer (bun test, no host).
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

  test("renderer sources mirror the same contract", async () => {
    const ts = await readText("./renderer.ts");
    const js = await readText("./renderer.js");
    for (const src of [ts, js]) {
      expect(src).toContain("fallbackCssId");
      expect(src).toContain("controlsObserved");
      expect(src).toContain("disconnectControlObserver");
      expect(src).toContain("removeFallbackCss");
      expect(src).toContain("WINDOW_CONTROL_SELECTOR");
      expect(src).toContain("DECORATIVE_FALLBACK_CSS");
      expect(src).toContain('ctx.config.get("decorative-fallback-lights") !== false');
      expect(src).not.toContain("WINDOW_CONTROL_SELECTORS");
    }
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
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      // Padding patch is still applied.
      expect(t.inserts.filter((c) => c.includes("--th-traffic-reserved")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("config undefined is treated as enabled", async () => {
    const t = makeTrackingCtx({
      configValue: undefined,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return hitElement();
      },
    });
    await plugin.activate(t.ctx);
    try {
      expect(t.observes.length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
      expect(t.inserts.filter((c) => c.includes("--th-traffic-reserved")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("miss registers observe once and inserts fallback once with pointer-events:none", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      const controlQueries = t.queries.filter((s) => !s.startsWith("observe:") && s !== "title");
      expect(controlQueries.length).toBe(1);
      // Single comma-separated selector covering real control groups, no pure .titlebar token.
      const selector = controlQueries[0];
      expect(selector).toContain(",");
      for (const token of [
        ".window-controls",
        ".window-controls-container",
        ".window-control",
        "winButtons",
        "p-titlebar__controls",
        "titlebar__controls",
        ".caption-buttons",
        ".captionButtons",
        ".frameless-controls",
        ".traffic-lights",
      ]) {
        expect(selector).toContain(token);
      }
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

  test("observe callback removes fallback, disconnects once, returns undefined", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      // deactivate removes the padding patch too; fallback id must appear exactly once.
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
          if (css.includes("pointer-events:none")) {
            return await gate;
          }
          return "mock-padding";
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

  test("deactivate cleans both patches and removes each id once", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
    });
    await plugin.activate(t.ctx);
    expect(t.inserts.length).toBe(2);
    const removesBefore = t.removes.length;
    await plugin.deactivate(t.ctx);
    expect(t.removes.length).toBe(removesBefore + 2);
    expect(new Set(t.removes).size).toBe(t.removes.length);
    const countAfterFirst = t.removes.length;
    await plugin.deactivate(t.ctx);
    expect(t.removes.length).toBe(countAfterFirst);
  });

  test("query throw fails closed: no fallback, no observe", async () => {
    const t = makeTrackingCtx({
      configValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
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
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
      removeShouldThrow: (id) => id === "mock-css-1",
    });
    await plugin.activate(t.ctx);
    // mock-css-1 is the fallback insert, mock-css-2 the padding patch.
    await expect(plugin.deactivate(t.ctx)).resolves.toBeUndefined();
    expect(t.removes).toContain("mock-css-1");
    expect(t.removes).toContain("mock-css-2");
    // State is cleared: a second deactivate performs no further removes.
    const n = t.removes.length;
    await plugin.deactivate(t.ctx);
    expect(t.removes.length).toBe(n);
  });
});

function makeOverlayCtx(opts: {
  decorativeValue?: unknown;
  functionalValue?: unknown;
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
        if (key === "functional-fallback-controls") return opts.functionalValue;
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
  functionalValue?: unknown;
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
        if (key === "functional-fallback-controls") return opts.functionalValue;
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

describe("manifest functional-fallback-controls", () => {
  test("declares electron.windowControls permission", async () => {
    const manifest = await readJson("../manifest.json");
    const permissions = manifest["permissions"] as unknown[];
    expect(permissions).toContain("electron.windowControls");
    expect(permissions).toContain("renderer.css");
    expect(permissions).toContain("renderer.dom");
    expect(permissions).toContain("renderer.script");
  });

  test("declares functional-fallback-controls boolean default true with functional host overlay label", async () => {
    const manifest = await readJson("../manifest.json");
    const config = manifest["config"] as Record<string, Record<string, unknown>>;
    const field = config["functional-fallback-controls"];
    expect(field).toBeDefined();
    expect(field["type"]).toBe("boolean");
    expect(field["default"]).toBe(true);
    const label = String(field["label"] ?? "").toLowerCase();
    expect(label).toContain("functional host overlay");
  });

  test("renderer sources mirror the functional contract without any abuse", async () => {
    const ts = await readText("./renderer.ts");
    const js = await readText("./renderer.js");
    for (const src of [ts, js]) {
      expect(src).toContain('ctx.config.get("functional-fallback-controls") !== false');
      expect(src).toContain("windowControls");
      expect(src).toContain("overlayMounted");
      expect(src).toContain("mountPending");
      expect(src).toContain("cancelPendingMount");
      expect(src).toContain("observeRegistered");
      expect(src).toContain("unmountOverlay");
      expect(src).toContain("getWindowControls");
      expect(src).toContain("mount()");
      expect(src).toContain("unmount()");
    }
    expect(ts).toContain("HostWindowControls");
    expect(ts).toContain("RendererContextWithOverlay");
    expect(ts).not.toContain("as any");
    expect(ts).not.toContain(": any");
    // Runtime must check existence before calling.
    expect(ts).toContain('typeof mount !== "function"');
    expect(ts).toContain('typeof unmount !== "function"');
  });
});

describe("functional fallback (host overlay) behavior", () => {
  test("mount priority: miss mounts overlay and skips decorative lights", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      functionalValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      // Padding patch still applied.
      expect(t.inserts.filter((c) => c.includes("--th-traffic-reserved")).length).toBe(1);
    } finally {
      await plugin.deactivate(t.ctx);
    }
  });

  test("mount reject falls back to decorative lights", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      functionalValue: true,
      mountImpl: async () => {
        throw new Error("mount denied");
      },
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      functionalValue: false,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      functionalValue: undefined,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      functionalValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return hitElement();
      },
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
      functionalValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      functionalValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      functionalValue: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
    });
    await plugin.activate(t.ctx);
    expect(t.mounts()).toBe(1);
    await expect(plugin.deactivate(t.ctx)).resolves.toBeUndefined();
    expect(t.unmounts()).toBe(1);
    // Decorative was never inserted, padding was removed; unmount not repeated.
    expect(t.inserts.filter((c) => c.includes("pointer-events:none")).length).toBe(0);
    const n = t.unmounts();
    await expect(plugin.deactivate(t.ctx)).resolves.toBeUndefined();
    expect(t.unmounts()).toBe(n);
  });

  test("deactivate still unmounts when decorative cleanup throws", async () => {
    const inserts: string[] = [];
    const removes: string[] = [];
    let mountCalls = 0;
    let unmountCalls = 0;
    let disconnectCalls = 0;
    let insertSeq = 0;
    const ctx = createMockRendererContext({
      // oxlint-disable-next-line no-explicit-any
      config: { get: () => true, set: () => {} } as any,
      // oxlint-disable-next-line no-explicit-any
      css: {
        insert: async (css: string) => {
          inserts.push(css);
          insertSeq += 1;
          return `mock-css-${insertSeq}`;
        },
        remove: async (id: string) => {
          removes.push(id);
          // Fail the padding removal (second insert), not the overlay path.
          if (id === "mock-css-1") throw new Error("remove failed");
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
      },
    };
    await plugin.activate(ctx);
    expect(mountCalls).toBe(1);
    // Decorative skipped (overlay up), so mock-css-1 is the padding patch.
    await expect(plugin.deactivate(ctx)).resolves.toBeUndefined();
    expect(unmountCalls).toBe(1);
    expect(disconnectCalls).toBe(1);
    expect(removes).toContain("mock-css-1");
    await plugin.deactivate(ctx);
  });

  test("observe failure fails closed: no overlay mount and no decorative insert", async () => {
    const t = makeOverlayCtx({
      decorativeValue: true,
      functionalValue: true,
      observeThrows: true,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      // Padding patch still applied.
      expect(t.inserts.filter((c) => c.includes("--th-traffic-reserved")).length).toBe(1);
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
      functionalValue: true,
      mountImpl: () => mountGate,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
      functionalValue: true,
      mountImpl: () => mountGate,
      queryImpl: async (selector) => {
        if (selector === "title") return null;
        return null;
      },
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
