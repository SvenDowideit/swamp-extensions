import { model } from "./cf_pages_wrangler.ts";

Deno.test("cloudflare pages extension exports a model", () => {
  if (model.type !== "@svendowideit/cloudflare-pages-wrangler") {
    throw new Error("unexpected model type");
  }
});
