/**
 * Tests for the swamp-ide setup model.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { herdrHomeOf, herdrPaths, model } from "./swamp_ide.ts";

Deno.test("herdrPaths puts the mod and layout under Herdr home", () => {
  const paths = herdrPaths("/tmp/herdr", "swamp-ide");
  assertEquals(paths.modDir, "/tmp/herdr/mods/swamp-activity");
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
