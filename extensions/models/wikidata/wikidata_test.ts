import { assertEquals } from "jsr:@std/assert@1";

import { extractClaimValues } from "./wikidata.ts";

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
