import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./news_html_report.ts";

const ctx = (overrides: Record<string, unknown> = {}) => ({
  scope: "method" as const,
  modelType: "@svendowideit/news-reader",
  modelId: "local-news",
  methodName: "generate",
  executionStatus: "succeeded" as const,
  dataHandles: [
    { name: "news.html", specName: "report", kind: "file", version: 3 },
  ],
  dataRepository: {
    getContent: async () => new TextEncoder().encode("<html>hi</html>"),
  },
  logger: { info: () => {} },
  ...overrides,
});

Deno.test("report returns empty for failed execution", async () => {
  const out = await report.execute(ctx({ executionStatus: "failed" }));
  assertEquals(out.markdown, "");
  assertEquals(out.json, {});
});

Deno.test("report returns empty for non-generate methods", async () => {
  const out = await report.execute(ctx({ methodName: "fetch" }));
  assertEquals(out.markdown, "");
  assertEquals(out.json, {});
});

Deno.test("report handles missing report handle", async () => {
  const out = await report.execute(ctx({ dataHandles: [] }));
  assertEquals(out.markdown, "No HTML report produced.");
  assertEquals(out.json, {});
});

Deno.test("report summarizes the generated HTML artifact", async () => {
  const out = await report.execute(ctx());
  assertEquals(out.markdown.includes("News Report Generated"), true);
  assertEquals(out.markdown.includes("news.html"), true);
  assertEquals(out.json, { handle: "news.html", version: 3, size: 15 });
});
