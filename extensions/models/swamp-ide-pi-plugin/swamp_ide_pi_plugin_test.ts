/**
 * Tests for the pi plugin installer/gate.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type GlobalArgs,
  MANAGED_MARKER,
  model,
  pathsFor,
} from "./swamp_ide_pi_plugin.ts";

function args(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return {
    piBin: "pi",
    scope: "project",
    projectDir: "/tmp/swamp-ide-project",
    force: false,
    ...overrides,
  };
}

Deno.test("project paths live under .pi", () => {
  const paths = pathsFor(args(), "project");
  assertEquals(
    paths.path,
    "/tmp/swamp-ide-project/.pi/extensions/swamp-ide.ts",
  );
  assertEquals(paths.markerDir, "/tmp/swamp-ide-project/.pi/swamp-ide");
});

Deno.test("global paths live under ~/.pi/agent", () => {
  const paths = pathsFor(args({ scope: "global" }), "global");
  assert(paths.path.endsWith("/.pi/agent/extensions/swamp-ide.ts"));
  assert(paths.markerDir.endsWith("/.pi/agent/swamp-ide"));
});

Deno.test("the managed marker is stable", () => {
  assertEquals(MANAGED_MARKER, "Managed by @svendowideit/swamp-ide-pi-plugin");
});

Deno.test("model exposes install, set, uninstall and status", () => {
  assertEquals(model.type, "@svendowideit/swamp-ide-pi-plugin");
  assertEquals(
    Object.keys(model.methods).sort(),
    ["install", "set", "status", "uninstall"],
  );
});
