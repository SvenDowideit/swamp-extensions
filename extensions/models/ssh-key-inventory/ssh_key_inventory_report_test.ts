import { report } from "./ssh_key_inventory_report.ts";

Deno.test("report extension is defined", () => {
  if (report.name !== "@svendowideit/ssh-key-summary") throw new Error("unexpected report name");
});
