/**
 * Tests for the pure helpers in `huggingface_shared.ts`: API parsing, GGUF quant
 * detection, URL building, and the budget-scored recommendation/ambiguity logic.
 * No network — the API bodies are supplied as literal JSON strings.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  assessFit,
  type Budget,
  buildRecommendation,
  buildResolveUrl,
  buildSearchUrl,
  buildTreeUrl,
  detectGgufQuant,
  formatBytes,
  isGgufFile,
  parseChatTemplate,
  parseContextLength,
  parseHfModelList,
  parseHfModelSummary,
  parseHfTree,
  renderDownloadScript,
  requirementToPipelineTag,
  searchTerms,
  selectGgufFiles,
} from "./huggingface_shared.ts";

Deno.test("renderDownloadScript is resumable, retrying and marks completion", () => {
  const s = renderDownloadScript({
    files: [
      {
        url: "https://huggingface.co/a/b/resolve/main/x.gguf",
        dest: "/d/x.gguf",
        expectedBytes: 100,
      },
    ],
    markerPath: "/d/.transfers/x.done",
    failPath: "/d/.transfers/x.fail",
    configPath: "/d/.transfers/x.curlrc",
  });
  assertStringIncludes(s, "set -u");
  assertStringIncludes(s, "curl -fL --retry 20 --retry-delay 5");
  assertStringIncludes(s, "-C -"); // resume
  assertStringIncludes(s, '-K "$CF"'); // auth config, not inline
  assertStringIncludes(
    s,
    "dl 'https://huggingface.co/a/b/resolve/main/x.gguf' '/d/x.gguf' 100",
  );
  assertStringIncludes(s, ': > "$DONE"');
  // A failure writes the fail marker.
  assertStringIncludes(s, ': > "$FAIL"; exit 1');
  // Token never appears in the script — only the config path.
  assertEquals(s.includes("Bearer"), false);
});

Deno.test("renderDownloadScript omits -K when there is no auth config", () => {
  const s = renderDownloadScript({
    files: [{ url: "u", dest: "d", expectedBytes: 0 }],
    markerPath: "m",
    failPath: "f",
  });
  assertEquals(s.includes('-K "$CF"'), false);
});

Deno.test("searchTerms falls back from the full ask to keywords to filter-only", () => {
  // The Hub cannot match a sentence, so the first term is the raw ask, then
  // the meaningful words, then the strongest word, then "" (filter-only).
  const terms = searchTerms("a local coding assistant for me");
  assertEquals(terms[0], "a local coding assistant for me");
  assertEquals(terms.includes("coding"), true);
  assertEquals(terms[terms.length - 1], "");
  // A one-word ask keeps a single keyword (plus the empty fallback).
  assertEquals(searchTerms("coding"), ["coding", ""]);
  // An all-stopword ask degrades to the empty term only.
  assertEquals(searchTerms("a model for me"), ["a model for me", ""]);
});

Deno.test("parseHfModelSummary reads the common fields and detects gating", () => {
  const s = parseHfModelSummary({
    id: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
    downloads: 12345,
    likes: 67,
    tags: ["text-generation", "gguf"],
    pipeline_tag: "text-generation",
    library_name: "gguf",
    gated: "auto",
    private: false,
    lastModified: "2026-01-01T00:00:00Z",
  });
  assertEquals(s?.id, "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF");
  assertEquals(s?.author, "Qwen");
  assertEquals(s?.downloads, 12345);
  assertEquals(s?.gated, true);
  assertEquals(s?.pipelineTag, "text-generation");
  assertEquals(parseHfModelSummary({ nope: 1 }), null);
});

Deno.test("parseHfModelList tolerates malformed rows and bad JSON", () => {
  const list = parseHfModelList(JSON.stringify([{ id: "a/b" }, { bad: true }]));
  assertEquals(list.length, 1);
  assertEquals(parseHfModelList("not json"), []);
});

Deno.test("detectGgufQuant finds the quant token, upper-cased", () => {
  assertEquals(
    detectGgufQuant("qwen2.5-coder-7b-instruct-q4_k_m.gguf"),
    "Q4_K_M",
  );
  assertEquals(detectGgufQuant("model-IQ4_XS.gguf"), "IQ4_XS");
  assertEquals(detectGgufQuant("model-Q8_0.gguf"), "Q8_0");
  assertEquals(detectGgufQuant("model-f16.gguf"), "F16");
  assertEquals(detectGgufQuant("model-bf16.gguf"), "BF16");
  assertEquals(detectGgufQuant("model.gguf"), "");
  assertEquals(detectGgufQuant("config.json"), "");
});

Deno.test("isGgufFile and selectGgufFiles", () => {
  assertEquals(isGgufFile("a.gguf"), true);
  assertEquals(isGgufFile("a.safetensors"), false);
  const files = parseHfTree(JSON.stringify([
    { type: "file", path: "a-Q4_K_M.gguf", size: 100 },
    { type: "file", path: "a-Q8_0.gguf", size: 200 },
    { type: "file", path: "README.md", size: 10 },
  ]));
  assertEquals(selectGgufFiles(files).length, 2);
  assertEquals(selectGgufFiles(files, "Q8_0").map((f) => f.path), [
    "a-Q8_0.gguf",
  ]);
});

Deno.test("parseHfTree reads LFS size/oid for large files", () => {
  const files = parseHfTree(JSON.stringify([
    {
      type: "file",
      path: "big-Q4_K_M.gguf",
      lfs: { size: 4683071232, oid: "abc123" },
    },
    { type: "directory", path: "sub" },
  ]));
  assertEquals(files.length, 1);
  assertEquals(files[0].sizeBytes, 4683071232);
  assertEquals(files[0].oid, "abc123");
  assertEquals(files[0].quant, "Q4_K_M");
});

Deno.test("parseContextLength tries the common config keys", () => {
  assertEquals(parseContextLength('{"max_position_embeddings":32768}'), 32768);
  assertEquals(parseContextLength('{"n_positions":2048}'), 2048);
  assertEquals(parseContextLength('{"context_length":8192}'), 8192);
  assertEquals(parseContextLength("{}"), 0);
  assertEquals(parseContextLength("not json"), 0);
});

Deno.test("parseChatTemplate prefers a jinja file, then tokenizer_config", () => {
  assertEquals(parseChatTemplate("{}", "{{ x }}"), "{{ x }}");
  assertEquals(parseChatTemplate('{"chat_template":"plain"}'), "plain");
  assertEquals(
    parseChatTemplate(
      JSON.stringify({
        chat_template: [{ name: "other", template: "o" }, {
          name: "default",
          template: "d",
        }],
      }),
    ),
    "d",
  );
  assertEquals(parseChatTemplate("{}"), "");
});

Deno.test("formatBytes scales to human units", () => {
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(4683071232), "4.4 GB");
  assertEquals(formatBytes(1536), "1.5 KB");
});

Deno.test("requirementToPipelineTag maps common asks", () => {
  assertEquals(
    requirementToPipelineTag("a coding assistant"),
    "text-generation",
  );
  assertEquals(
    requirementToPipelineTag("transcribe my meetings"),
    "automatic-speech-recognition",
  );
  assertEquals(
    requirementToPipelineTag("draw a picture of a cat"),
    "text-to-image",
  );
  assertEquals(
    requirementToPipelineTag("embeddings for search"),
    "feature-extraction",
  );
  assertEquals(requirementToPipelineTag("something odd"), "");
});

Deno.test("URL builders include the expected path and params", () => {
  const search = new URL(
    buildSearchUrl("https://huggingface.co/", {
      ask: "coder",
      limit: 5,
      library: "gguf",
    }),
  );
  assertEquals(search.pathname, "/api/models");
  assertEquals(search.searchParams.get("search"), "coder");
  assertEquals(search.searchParams.get("filter"), "gguf");
  // "coder" is inferred as text-generation.
  assertEquals(search.searchParams.get("pipeline_tag"), "text-generation");
  assertEquals(search.searchParams.get("limit"), "5");
  assertEquals(
    buildTreeUrl("https://huggingface.co", "a/b", "main"),
    "https://huggingface.co/api/models/a/b/tree/main?recursive=true",
  );
  assertEquals(
    buildResolveUrl("https://huggingface.co", "a/b", "main", "x.gguf"),
    "https://huggingface.co/a/b/resolve/main/x.gguf",
  );
});

Deno.test("assessFit picks gpu, cpu, or too-large", () => {
  const small: Budget = { vramMiB: 24564, ramMiB: 128000 };
  assertEquals(assessFit(7000, small).verdict, "gpu");
  assertEquals(assessFit(30000, small).verdict, "cpu");
  assertEquals(assessFit(200000, small).verdict, "too-large");
  // CPU-only host (no VRAM): fits RAM.
  assertEquals(assessFit(7000, { vramMiB: 0, ramMiB: 64000 }).verdict, "cpu");
});

Deno.test("buildRecommendation ranks gpu first and flags ambiguity", () => {
  const rec = buildRecommendation(
    "a coder",
    { vramMiB: 24564, ramMiB: 128000 },
    [
      {
        repo: "big/coder",
        quant: "Q8_0",
        file: "c-Q8_0.gguf",
        sizeBytes: 30000 * 1048576,
      },
      {
        repo: "mid/coder",
        quant: "Q4_K_M",
        file: "c-Q4_K_M.gguf",
        sizeBytes: 7000 * 1048576,
      },
      {
        repo: "huge/coder",
        quant: "Q8_0",
        file: "c-Q8_0.gguf",
        sizeBytes: 200000 * 1048576,
      },
    ],
  );
  // The two GPU-fit candidates come first, largest (most capable) leading.
  assertEquals(rec.candidates[0].repo, "mid/coder");
  assertEquals(rec.candidates[1].repo, "big/coder");
  assertEquals(rec.candidates[2].verdict, "too-large");
  assertEquals(rec.ambiguous, true);
  assertEquals(rec.options.length, 2);
  assertEquals(rec.options[0].value, "mid/coder#Q4_K_M");
  assertEquals(rec.question.includes("mid/coder#Q4_K_M"), true);
});

Deno.test("buildRecommendation is unambiguous with one fit", () => {
  const rec = buildRecommendation(
    "a coder",
    { vramMiB: 24564, ramMiB: 128000 },
    [
      {
        repo: "mid/coder",
        quant: "Q4_K_M",
        file: "c-Q4_K_M.gguf",
        sizeBytes: 7000 * 1048576,
      },
    ],
  );
  assertEquals(rec.ambiguous, false);
  assertEquals(rec.options, []);
  assertEquals(rec.question, "");
});
