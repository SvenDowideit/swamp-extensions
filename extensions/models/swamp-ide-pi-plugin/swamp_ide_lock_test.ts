/** Tests for the cross-process approval lock. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireApprovalLock } from "./pi/swamp-ide-lock.ts";

async function tempLockPath(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-ide-lock-" });
  return join(dir, "approval.lock");
}

Deno.test("the approval lock is exclusive and releases only its own token", async () => {
  const path = await tempLockPath();
  const first = await acquireApprovalLock({ path, waitMs: 0 });
  assert(first);
  assertEquals(await acquireApprovalLock({ path, waitMs: 0 }), null);
  assert(await first.heartbeat());
  assert(await first.release());
  assertEquals(await first.release(), false);
});

Deno.test("a zero-byte stale lock is recovered without parsing it", async () => {
  const path = await tempLockPath();
  await writeFile(path, "", "utf8");
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  const lock = await acquireApprovalLock({ path, waitMs: 0 });
  assert(lock);
  assert(await lock.release());
});

Deno.test("a fresh unparsable lock blocks only until the bounded wait", async () => {
  const path = await tempLockPath();
  await writeFile(path, "{not json", "utf8");
  assertEquals(await acquireApprovalLock({ path, waitMs: 0 }), null);
});

Deno.test("acquisition observes the abort signal", async () => {
  const path = await tempLockPath();
  const controller = new AbortController();
  controller.abort();
  assertEquals(
    await acquireApprovalLock({
      path,
      waitMs: 10_000,
      signal: controller.signal,
    }),
    null,
  );
});

Deno.test("a stolen holder cannot heartbeat or release the new lock", async () => {
  const path = await tempLockPath();
  const first = await acquireApprovalLock({ path, waitMs: 0 });
  assert(first);
  await writeFile(
    path,
    JSON.stringify({ token: "new-holder", pid: 999, at: Date.now() }),
    "utf8",
  );
  assertEquals(await first.heartbeat(), false);
  const current = JSON.parse(await readFile(path, "utf8"));
  assertEquals(current.token, "new-holder");
  assertEquals(await first.release(), false);
  assertEquals(JSON.parse(await readFile(path, "utf8")).token, "new-holder");
});
