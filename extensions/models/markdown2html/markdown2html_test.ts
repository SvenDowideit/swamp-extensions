import { model } from "./markdown2html.ts";

Deno.test("markdown2html extension exports a model", () => {
  if (model.type !== "@svendowideit/markdown2html") throw new Error("unexpected type");
});
