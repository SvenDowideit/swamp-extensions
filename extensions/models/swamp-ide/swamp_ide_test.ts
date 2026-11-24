/**
 * Tests for the swamp-ide setup model.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applySwampBar,
  barBlocksFor,
  herdrHomeOf,
  herdrPaths,
  model,
} from "./swamp_ide.ts";

Deno.test("herdrPaths puts the mods and layout under Herdr home", () => {
  const paths = herdrPaths("/tmp/herdr", "swamp-ide");
  assertEquals(paths.modDir, "/tmp/herdr/mods/swamp-activity");
  assertEquals(paths.ideModDir, "/tmp/herdr/mods/swamp-ide");
  assertEquals(paths.layoutPath, "/tmp/herdr/layouts/swamp-ide.json");
});

Deno.test("herdrHomeOf prefers the explicit global argument", () => {
  assertEquals(
    herdrHomeOf({
      herdrBin: "herdr-app",
      herdrHome: "/tmp/h",
      layout: "swamp-ide",
      baseLayout: "swamp",
    }),
    "/tmp/h",
  );
});

Deno.test("model exposes setHerdr and status", () => {
  assert(model.type === "@svendowideit/swamp-ide");
  assertEquals(Object.keys(model.methods).sort(), ["setHerdr", "status"]);
});

// ---------------------------------------------------------------------------
// The swamp bar
// ---------------------------------------------------------------------------

interface LayoutNode {
  id?: string;
  children?: LayoutNode[];
  [key: string]: unknown;
}

function at(node: unknown, ...ids: string[]): LayoutNode {
  let found = node as LayoutNode;
  for (const id of ids) {
    const next = (found?.children ?? []).find((child) => child.id === id);
    if (!next) throw new Error(`no node ${id}`);
    found = next;
  }
  return found;
}

function ids(node: LayoutNode): Array<string | undefined> {
  return (node.children ?? []).map((child) => child.id);
}

function baseLayout(): LayoutNode {
  return {
    id: "root",
    type: "row",
    children: [
      { id: "sidebar", type: "column", children: [] },
      {
        id: "work",
        type: "column",
        children: [
          {
            id: "tabs",
            type: "block",
            content: { mod: "tabs" },
            size: { px: 42 },
            window_drag: true,
          },
          {
            id: "work-body",
            type: "row",
            children: [
              { id: "main", type: "block", content: { tab: "active" } },
            ],
          },
          {
            id: "status-row",
            type: "row",
            size: { px: 28 },
            children: [
              {
                id: "status",
                type: "block",
                content: { mod: "workspace-status" },
                size: { weight: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

const BOTH = barBlocksFor({ idea: true, browser: true });

Deno.test("barBlocksFor only places the mods that are installed", () => {
  assertEquals(barBlocksFor({ idea: false, browser: false }), []);
  assertEquals(barBlocksFor({ idea: true, browser: false }).map((b) => b.id), [
    "obsidian-idea",
  ]);
  assertEquals(BOTH.map((b) => b.id), ["obsidian-idea", "browser-launch"]);
});

Deno.test("applySwampBar puts the bar beside the tab strip", () => {
  const out = applySwampBar(baseLayout(), {
    placement: "tabbar",
    blocks: BOTH,
  });
  const work = at(out, "work");
  assertEquals(ids(work), ["bar", "work-body", "status-row"]);
  const bar = at(out, "work", "bar");
  assertEquals(bar.type, "row");
  assertEquals(bar.size, { px: 42 });
  assertEquals(bar.window_drag, true);
  assertEquals(bar.gap, 6);
  assertEquals(ids(bar), ["tabs", "obsidian-idea", "browser-launch"]);
  const children = bar.children ?? [];
  assertEquals(children[0].size, { weight: 1 });
  assertEquals(children[0].window_drag, undefined);
  assertEquals(children[1], {
    id: "obsidian-idea",
    type: "block",
    content: { mod: "obsidian-idea", props: { compact: true } },
    size: { px: 320 },
  });
  assertEquals(children[2], {
    id: "browser-launch",
    type: "block",
    content: { mod: "browser-launch" },
    size: { px: 118 },
  });
});

Deno.test("applySwampBar is idempotent", () => {
  const once = applySwampBar(baseLayout(), {
    placement: "tabbar",
    blocks: BOTH,
  });
  const twice = applySwampBar(once, { placement: "tabbar", blocks: BOTH });
  assertEquals(twice, once);
});

Deno.test("applySwampBar takes its blocks out again", () => {
  const withBar = applySwampBar(baseLayout(), {
    placement: "tabbar",
    blocks: BOTH,
  });
  const out = applySwampBar(withBar, { placement: "tabbar", blocks: [] });
  const work = at(out, "work");
  assertEquals(ids(work), ["tabs", "work-body", "status-row"]);
  assertEquals(work.children?.[0], {
    id: "tabs",
    type: "block",
    content: { mod: "tabs" },
    size: { px: 42 },
    window_drag: true,
  });
});

Deno.test("applySwampBar can use the status row instead", () => {
  const out = applySwampBar(baseLayout(), {
    placement: "statusbar",
    blocks: BOTH,
  });
  const row = at(out, "work", "status-row");
  assertEquals(row.size, { px: 32 });
  assertEquals(ids(row), ["status", "obsidian-idea", "browser-launch"]);
  // the tab strip is untouched by this placement
  assertEquals(at(out, "work", "tabs").window_drag, true);

  const removed = applySwampBar(out, { placement: "statusbar", blocks: [] });
  const back = at(removed, "work", "status-row");
  assertEquals(back.size, { px: 28 });
  assertEquals(ids(back), ["status"]);
});

Deno.test("applySwampBar leaves every other node alone", () => {
  const input = baseLayout();
  const out = applySwampBar(input, { placement: "tabbar", blocks: BOTH });
  // the input is not mutated
  assertEquals(input, baseLayout());
  assertEquals(at(out, "sidebar"), at(baseLayout(), "sidebar"));
  assertEquals(
    at(out, "work", "work-body"),
    at(baseLayout(), "work", "work-body"),
  );
  assertEquals(
    at(out, "work", "status-row"),
    at(baseLayout(), "work", "status-row"),
  );
});

Deno.test("applySwampBar leaves a layout with no work column unchanged", () => {
  const layout = { id: "root", type: "row", children: [] };
  assertEquals(
    applySwampBar(layout, { placement: "tabbar", blocks: BOTH }),
    layout,
  );
});
