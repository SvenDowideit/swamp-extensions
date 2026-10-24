import { assertEquals } from "jsr:@std/assert@1";

import { report } from "./dreamhost_inventory_report.ts";

Deno.test("dreamhost inventory report names its scope", () => {
  assertEquals(report.name, "@svendowideit/dreamhost-inventory-report");
  assertEquals(report.scope, "workflow");
});
