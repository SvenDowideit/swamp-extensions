import { isAlreadyBound, model } from "./cf_pages_wrangler.ts";

Deno.test("cloudflare pages extension exports a model", () => {
  if (model.type !== "@svendowideit/cloudflare-pages-wrangler") {
    throw new Error("unexpected model type");
  }
});

Deno.test("an already-bound domain is an idempotent success", () => {
  if (!isAlreadyBound(new Error("Cloudflare Pages request failed (400): {\"code\":8000018}"))) {
    throw new Error("expected 8000018 to be recognized");
  }
  if (!isAlreadyBound(new Error("You have already added this custom domain"))) {
    throw new Error("expected the already-added message to be recognized");
  }
  if (isAlreadyBound(new Error("permission denied"))) {
    throw new Error("unrelated errors must not be swallowed");
  }
});
