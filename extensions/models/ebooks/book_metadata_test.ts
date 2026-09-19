import { assertEquals } from "jsr:@std/assert@1";

import { detectInfobox } from "./book_metadata.ts";

Deno.test("detectInfobox finds a writer infobox", () => {
  const wikitext = `{{short description|American science fiction author}}
{{Infobox writer
 | name = Alfred Bester
 | birth_date = 1913
}}
`;
  assertEquals(detectInfobox(wikitext), "infobox writer");
});

Deno.test("detectInfobox finds a book infobox", () => {
  const wikitext = `{{Infobox book
 | name = The Demolished Man
 | author = Alfred Bester
}}
`;
  assertEquals(detectInfobox(wikitext), "infobox book");
});

Deno.test("detectInfobox is case-insensitive and underscore-tolerant", () => {
  assertEquals(detectInfobox("{{Infobox_Novelist |name=..."), "infobox novelist");
  assertEquals(detectInfobox("{{Infobox Person |name=..."), "infobox person");
});

Deno.test("detectInfobox returns null when no infobox present", () => {
  assertEquals(detectInfobox("{{Short description|A natural number}}"), null);
  assertEquals(detectInfobox(null), null);
});
