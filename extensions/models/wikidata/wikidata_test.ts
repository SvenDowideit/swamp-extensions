import { assertEquals } from "jsr:@std/assert@1";

import { extractClaimValues, localized, parseEntities } from "./wikidata.ts";

Deno.test("extractClaimValues pulls value ids from value snaks", () => {
  const claims = [
    { mainsnak: { datavalue: { value: { id: "Q5" } } } },
    { mainsnak: { datavalue: { value: { id: "Q149454" } } } },
  ];
  assertEquals(extractClaimValues(claims), ["Q5", "Q149454"]);
});

Deno.test("extractClaimValues skips novalue/somevalue snaks", () => {
  const claims = [
    { mainsnak: { snaktype: "novalue" } },
    { mainsnak: { snaktype: "somevalue" } },
    { mainsnak: { datavalue: { value: { id: "Q571" } } } },
  ];
  assertEquals(extractClaimValues(claims), ["Q571"]);
});

Deno.test("extractClaimValues handles missing/empty claims", () => {
  assertEquals(extractClaimValues(undefined), []);
  assertEquals(extractClaimValues([]), []);
});

Deno.test("parseEntities returns null for non-objects", () => {
  assertEquals(parseEntities(null), null);
  assertEquals(parseEntities("nope"), null);
  assertEquals(parseEntities(42), null);
});

Deno.test("parseEntities returns null when no entities key", () => {
  assertEquals(parseEntities({ foo: "bar" }), null);
});

Deno.test("parseEntities extracts the entities map", () => {
  const entities = parseEntities({
    entities: { Q286116: { id: "Q286116", type: "item" } },
  });
  assertEquals(entities !== null, true);
  assertEquals(entities!["Q286116"]!.id, "Q286116");
});

Deno.test("localized returns the matching language first", () => {
  const map = {
    en: { language: "en", value: "Alfred Bester" },
    de: { language: "de", value: "Alfred Bester (de)" },
  };
  assertEquals(localized(map, "en"), "Alfred Bester");
});

Deno.test("localized falls back to the first entry", () => {
  const map = {
    de: { language: "de", value: "Alfred Bester (de)" },
  };
  assertEquals(localized(map, "en"), "Alfred Bester (de)");
});

Deno.test("localized returns null when map is absent or empty", () => {
  assertEquals(localized(undefined, "en"), null);
  assertEquals(localized({}, "en"), null);
});
