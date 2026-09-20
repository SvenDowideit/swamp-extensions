import { assertEquals } from "jsr:@std/assert@1";

import { detectInfoboxName, parseInfoboxTemplate } from "./wikipedia.ts";

Deno.test("detectInfoboxName finds a writer infobox", () => {
  const wikitext = `{{short description|American science fiction author}}
{{Infobox writer
 | name = Alfred Bester
}}
`;
  assertEquals(detectInfoboxName(wikitext), "infobox writer");
});

Deno.test("detectInfoboxName is case-insensitive and underscore-tolerant", () => {
  assertEquals(detectInfoboxName("{{Infobox_Novelist |name=..."), "infobox novelist");
  assertEquals(detectInfoboxName("{{Infobox Person |name=..."), "infobox person");
});

Deno.test("parseInfoboxTemplate extracts key/value params", () => {
  const wikitext = `{{Infobox writer
 | name = Alfred Bester
 | birth_date = {{Birth date|1913|12|18}}
 | occupation = Novelist
 | notable_works = The Demolished Man
}}`;
  const parsed = parseInfoboxTemplate(wikitext);
  assertEquals(parsed._template, "infobox writer");
  assertEquals(parsed["name"], "Alfred Bester");
  assertEquals(parsed["birth_date"], "{{Birth date|1913|12|18}}");
  assertEquals(parsed["occupation"], "Novelist");
  assertEquals(parsed["notable_works"], "The Demolished Man");
});
