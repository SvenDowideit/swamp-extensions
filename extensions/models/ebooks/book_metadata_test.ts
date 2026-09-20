import { assertEquals } from "jsr:@std/assert@1";

import {
  classifyResolved,
  decodeText,
  pickCandidate,
} from "./book_metadata.ts";

Deno.test("classifyResolved: writer infobox → author", () => {
  assertEquals(classifyResolved("infobox writer", null), "author");
});

Deno.test("classifyResolved: book infobox → book", () => {
  assertEquals(classifyResolved("infobox book", null), "book");
});

Deno.test("classifyResolved: unknown infobox, human QID → author", () => {
  assertEquals(classifyResolved("infobox foo", ["Q5"]), "author");
});

Deno.test("classifyResolved: unknown infobox, book QID → book", () => {
  assertEquals(classifyResolved(null, ["Q571"]), "book");
});

Deno.test("classifyResolved: no signals → other", () => {
  assertEquals(classifyResolved(null, null), "other");
  assertEquals(classifyResolved("infobox something", []), "other");
});

Deno.test("pickCandidate: prefers shortdesc matching expected kind", () => {
  const results = [
    { title: "Alfred Bester", description: null, url: "https://x/A" },
    {
      title: "Alfred Bester (Babylon 5)",
      description: "Fictional character",
      url: "https://x/B",
    },
  ];
  const pages = {
    "Alfred Bester": {
      title: "Alfred Bester",
      url: "https://x/A",
      shortdesc: "American science fiction author",
      wikidataId: "Q286116",
    },
    "Alfred Bester (Babylon 5)": {
      title: "Alfred Bester (Babylon 5)",
      url: "https://x/B",
      shortdesc: "Fictional character",
      wikidataId: null,
    },
  };
  const chosen = pickCandidate("author", results, pages);
  assertEquals(chosen?.title, "Alfred Bester");
  assertEquals(chosen?.wikidataId, "Q286116");
});

Deno.test("pickCandidate: falls back to first when no description matches", () => {
  const results = [
    { title: "First", description: null, url: "https://x/1" },
    { title: "Second", description: null, url: "https://x/2" },
  ];
  const chosen = pickCandidate("book", results, {});
  assertEquals(chosen?.title, "First");
});

Deno.test("pickCandidate: returns null for empty results", () => {
  assertEquals(pickCandidate("author", [], {}), null);
});

Deno.test("decodeText: UTF-8 passes through unchanged", () => {
  const bytes = new TextEncoder().encode("Alfred Bester");
  assertEquals(decodeText(bytes), "Alfred Bester");
});

Deno.test("decodeText: UTF-16LE BOM decodes correctly", () => {
  const s = "R. A. Salvatore";
  const le = new Uint8Array(s.length * 2 + 2);
  le[0] = 0xff;
  le[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    le[2 + i * 2] = c & 0xff;
    le[3 + i * 2] = (c >> 8) & 0xff;
  }
  assertEquals(decodeText(le), s);
});

Deno.test("decodeText: BOM-less UTF-16LE decodes correctly", () => {
  const s = "R. A. Salvatore";
  const le = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    le[i * 2] = c & 0xff;
    le[i * 2 + 1] = (c >> 8) & 0xff;
  }
  assertEquals(decodeText(le), s);
});

Deno.test("decodeText: UTF-16BE BOM decodes correctly", () => {
  const s = "Author Name";
  const be = new Uint8Array(s.length * 2 + 2);
  be[0] = 0xfe;
  be[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    be[2 + i * 2] = (c >> 8) & 0xff;
    be[3 + i * 2] = c & 0xff;
  }
  assertEquals(decodeText(be), s);
});
