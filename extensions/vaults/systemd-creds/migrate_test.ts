import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, type MigrationContext } from "./migrate.ts";

/** A tiny in-memory vault service for exercising the migration logic. */
function fakeVaultService(
  initial: Record<string, Record<string, string>>,
  supportsDelete = true,
) {
  const stores: Record<string, Map<string, string>> = {};
  for (const [name, entries] of Object.entries(initial)) {
    stores[name] = new Map(Object.entries(entries));
  }
  const calls: string[] = [];
  const service = {
    async get(vault: string, key: string): Promise<string> {
      calls.push(`get:${vault}:${key}`);
      const v = stores[vault]?.get(key);
      if (v === undefined) throw new Error(`not found: ${vault}/${key}`);
      return v;
    },
    async put(vault: string, key: string, value: string): Promise<void> {
      calls.push(`put:${vault}:${key}`);
      stores[vault] = stores[vault] ?? new Map();
      stores[vault].set(key, value);
    },
    async delete(vault: string, key: string): Promise<void> {
      calls.push(`delete:${vault}:${key}`);
      stores[vault]?.delete(key);
    },
    async list(vault: string): Promise<string[]> {
      return [...(stores[vault]?.keys() ?? [])].sort();
    },
    getVaultNames(): string[] {
      return Object.keys(stores);
    },
    supportsDelete(): boolean {
      return supportsDelete;
    },
  };
  return { service, stores, calls };
}

/** Capture the data a method writes, so assertions can read the result. */
function captureContext(service: MigrationContext["vaultService"]) {
  let written: Record<string, unknown> = {};
  const context: MigrationContext = {
    vaultService: service,
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      written = data;
      return Promise.resolve({ name: "main" });
    },
  };
  return { context, result: () => written };
}

const typeCheck = () => {
  assertEquals(model.type, "@svendowideit/vault-migrate");
  assertEquals(typeof model.methods.plan.execute, "function");
  assertEquals(typeof model.methods.migrate.execute, "function");
};

Deno.test("model exposes plan and migrate methods", typeCheck);

Deno.test("every action the model can emit is documented in the schema", () => {
  // The KeyResultSchema `action` description must name each action the code
  // can produce, so the published method reference is accurate.
  const ks = model.resources.result.schema.shape.keys;
  const desc = ks.element.shape.action.description ?? "";
  const emitted = [
    "copied",
    "skipped-exists",
    "failed",
    "copied-delete-failed",
  ];
  for (const a of emitted) {
    assertEquals(
      desc.includes(a),
      true,
      `action ${a} must be described in KeyResultSchema`,
    );
  }
});

Deno.test("plan lists keys and marks those already in the target", async () => {
  const { service } = fakeVaultService({
    global: { A: "1", B: "2", C: "3" },
    "my-vault": { B: "existing" },
  });
  const { context, result } = captureContext(service);

  await model.methods.plan.execute({ from: "global", to: "my-vault", force: false }, context);

  const r = result();
  assertEquals(r.mode, "plan");
  assertEquals(r.skipped, 1); // B already exists
  const keys = r.keys as { key: string; action: string }[];
  assertEquals(keys.find((k) => k.key === "B")?.action, "skipped-exists");
  assertEquals(keys.find((k) => k.key === "A")?.action, "copied");
  assertEquals(r.copied, 0); // plan writes nothing
});

Deno.test("migrate moves keys and deletes them from the source", async () => {
  const { service, stores, calls } = fakeVaultService({
    global: { A: "1", B: "2", C: "3" },
    "my-vault": {},
  });
  const { context, result } = captureContext(service);

  await model.methods.migrate.execute(
    { from: "global", to: "my-vault", force: false, deleteSource: true },
    context,
  );

  const r = result();
  assertEquals(r.mode, "move");
  assertEquals(r.copied, 3);
  assertEquals(r.deleted, 3);
  assertEquals([...stores["my-vault"].keys()].sort(), ["A", "B", "C"]);
  assertEquals([...stores["global"].keys()], []);
  assertEquals(calls.filter((c) => c.startsWith("delete:global")).length, 3);
});

Deno.test("migrate with deleteSource=false copies and leaves the source", async () => {
  const { service, stores } = fakeVaultService({
    global: { A: "1" },
    dest: {},
  });
  const { context, result } = captureContext(service);

  await model.methods.migrate.execute(
    { from: "global", to: "dest", force: false, deleteSource: false },
    context,
  );

  const r = result();
  assertEquals(r.mode, "copy");
  assertEquals(r.copied, 1);
  assertEquals(r.deleted, 0);
  assertEquals([...stores["global"].keys()], ["A"]);
  assertEquals([...stores["dest"].keys()], ["A"]);
});

Deno.test("migrate skips existing target keys unless force is set", async () => {
  const { service, stores } = fakeVaultService({
    src: { A: "new" },
    dst: { A: "old" },
  });
  const { context, result } = captureContext(service);

  await model.methods.migrate.execute(
    { from: "src", to: "dst", force: false, deleteSource: true },
    context,
  );
  assertEquals(result().skipped, 1);
  assertEquals(stores["dst"].get("A"), "old"); // untouched

  await model.methods.migrate.execute(
    { from: "src", to: "dst", force: true, deleteSource: true },
    context,
  );
  assertEquals(stores["dst"].get("A"), "new"); // overwritten
});

Deno.test("migrate only touches the keys given in `keys`", async () => {
  const { service, stores } = fakeVaultService({
    src: { A: "1", B: "2", C: "3" },
    dst: {},
  });
  const { context } = captureContext(service);

  await model.methods.migrate.execute(
    { from: "src", to: "dst", keys: ["B"], force: false, deleteSource: true },
    context,
  );
  assertEquals([...stores["dst"].keys()], ["B"]);
  assertEquals([...stores["src"].keys()].sort(), ["A", "C"]);
});

Deno.test("migrate leaves source intact when it does not support delete", async () => {
  const { service, stores } = fakeVaultService({ src: { A: "1" }, dst: {} }, false);
  const { context, result } = captureContext(service);

  await model.methods.migrate.execute(
    { from: "src", to: "dst", force: false, deleteSource: true },
    context,
  );
  assertEquals(result().deleted, 0);
  assertEquals(result().sourceSupportsDelete, false);
  assertEquals([...stores["src"].keys()], ["A"]);
  assertEquals([...stores["dst"].keys()], ["A"]);
});

Deno.test("a key that fails to copy is reported, others continue", async () => {
  const { service, stores } = fakeVaultService({
    src: { A: "1", BAD: "x", C: "3" },
    dst: {},
  });
  // Make one key throw on get by removing it behind the service's back.
  const origGet = service.get.bind(service);
  service.get = async (vault: string, key: string) => {
    if (key === "BAD") throw new Error("decrypt failed");
    return origGet(vault, key);
  };
  const { context, result } = captureContext(service);

  await model.methods.migrate.execute(
    { from: "src", to: "dst", force: false, deleteSource: true },
    context,
  );
  const r = result();
  assertEquals(r.failed, 1);
  assertEquals(r.copied, 2);
  assertEquals([...stores["dst"].keys()].sort(), ["A", "C"]);
});

Deno.test("a copy that succeeds but whose source-delete fails is not a copy failure", async () => {
  const { service, stores } = fakeVaultService({ src: { A: "1" }, dst: {} });
  // The delete throws, but the value is already safely in the target.
  service.delete = () => {
    return Promise.reject(new Error("source delete exploded"));
  };
  const { context, result } = captureContext(service);

  await model.methods.migrate.execute(
    { from: "src", to: "dst", force: false, deleteSource: true },
    context,
  );
  const r = result();
  assertEquals(r.copied, 1, "the copy must count as copied");
  assertEquals(r.failed, 0, "a delete failure must not count as a copy failure");
  assertEquals(r.deleted, 0);
  assertEquals(stores["dst"].get("A"), "1", "value is in the target");
  const keys = r.keys as { key: string; action: string; error: string }[];
  assertEquals(keys[0].action, "copied-delete-failed");
  assertEquals(keys[0].error.includes("source delete exploded"), true);
});

Deno.test("migrate refuses an unknown vault", async () => {
  const { service } = fakeVaultService({ src: { A: "1" } });
  const { context } = captureContext(service);
  await assertRejects(
    () =>
      model.methods.migrate.execute(
        { from: "src", to: "nope", force: false, deleteSource: true },
        context,
      ),
    Error,
    "not found",
  );
});

Deno.test("migrate refuses identical source and target", async () => {
  const { service } = fakeVaultService({ src: { A: "1" } });
  const { context } = captureContext(service);
  await assertRejects(
    () =>
      model.methods.migrate.execute(
        { from: "src", to: "src", force: false, deleteSource: true },
        context,
      ),
    Error,
    "must be different",
  );
});

Deno.test("migrate refuses a requested key absent from the source", async () => {
  const { service } = fakeVaultService({ src: { A: "1" }, dst: {} });
  const { context } = captureContext(service);
  await assertRejects(
    () =>
      model.methods.migrate.execute(
        { from: "src", to: "dst", keys: ["MISSING"], force: false, deleteSource: true },
        context,
      ),
    Error,
    "not present",
  );
});
