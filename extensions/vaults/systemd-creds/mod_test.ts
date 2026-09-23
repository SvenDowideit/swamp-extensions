import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { assertSafeSecretKey, vault } from "./mod.ts";

type RunResult = { stdout: string; stderr: string; code: number };
type RunCommand = (args: string[], stdin?: string) => Promise<RunResult>;

Deno.test("vault export has correct metadata", () => {
  assertEquals(vault.type, "@svendowideit/systemd-creds");
  assertEquals(vault.name, "systemd-creds Vault");
  assertEquals(typeof vault.description, "string");
  assertEquals(typeof vault.createProvider, "function");
});

Deno.test("configSchema accepts valid config", () => {
  const schema = vault.configSchema!;
  assertEquals(schema.parse({}), { credstoreDir: "~/.config/credstore" });
  assertEquals(schema.parse({ credstoreDir: "/custom/path" }), { credstoreDir: "/custom/path" });
});

Deno.test("configSchema rejects invalid config", () => {
  const schema = vault.configSchema!;
  try {
    schema.parse({ credstoreDir: 123 });
    throw new Error("should have thrown");
  } catch {
    // expected
  }
});

Deno.test("put encrypts and stores secret via systemd-creds", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const runCommand: RunCommand = async (args, stdin) => {
    calls.push({ args, stdin });
    return { stdout: "", stderr: "", code: 0 };
  };

  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/test-credstore" }, runCommand);
  await provider.put("my-key", "my-secret-value");

  assertEquals(calls.length, 1);
  assertEquals(calls[0].args, ["encrypt", "-", "/tmp/test-credstore/my-key.cred"]);
  assertEquals(calls[0].stdin, "my-secret-value");
});

Deno.test("get decrypts secret via systemd-creds", async () => {
  const runCommand: RunCommand = async (args) => {
    assertEquals(args, ["decrypt", "/tmp/test-credstore/my-key.cred", "-"]);
    return { stdout: "decrypted-value", stderr: "", code: 0 };
  };

  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/test-credstore" }, runCommand);
  const result = await provider.get("my-key");

  assertEquals(result, "decrypted-value");
});

Deno.test("get throws on decrypt failure", async () => {
  const runCommand: RunCommand = async () => {
    return { stdout: "", stderr: "decryption failed: bad key", code: 1 };
  };

  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/test-credstore" }, runCommand);
  await assertRejects(
    () => provider.get("bad-key"),
    Error,
    "decryption failed: bad key",
  );
});

Deno.test("put throws on encrypt failure", async () => {
  const runCommand: RunCommand = async () => {
    return { stdout: "", stderr: "encryption failed: no TPM", code: 1 };
  };

  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/test-credstore" }, runCommand);
  await assertRejects(
    () => provider.put("bad-key", "value"),
    Error,
    "encryption failed: no TPM",
  );
});

Deno.test("list returns sorted keys from credstore dir", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-credstore-" });
  try {
    await Deno.writeTextFile(`${tmpDir}/alpha.cred`, "encrypted");
    await Deno.writeTextFile(`${tmpDir}/beta.cred`, "encrypted");
    await Deno.writeTextFile(`${tmpDir}/not-a-cred.txt`, "plain");

    const provider = vault.createProvider("test-vault", { credstoreDir: tmpDir });
    const keys = await provider.list();

    assertEquals(keys, ["alpha", "beta"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("list returns empty array for missing dir", async () => {
  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/nonexistent-dir-xyz" });
  const keys = await provider.list();
  assertEquals(keys, []);
});

Deno.test("getName returns vault name", () => {
  const provider = vault.createProvider("my-vault-name", {});
  assertEquals(provider.getName(), "my-vault-name");
});

Deno.test("put/get roundtrip with mocked systemd-creds", async () => {
  const stored = new Map<string, string>();

  const runCommand: RunCommand = async (args, stdin) => {
    if (args[0] === "encrypt") {
      const filePath = args[2];
      const key = filePath.split("/").pop()!.replace(".cred", "");
      stored.set(key, stdin ?? "");
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "decrypt") {
      const filePath = args[1];
      const key = filePath.split("/").pop()!.replace(".cred", "");
      if (stored.has(key)) {
        return { stdout: `value-for-${key}`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "not found", code: 1 };
    }
    return { stdout: "", stderr: "unexpected", code: 1 };
  };

  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/test-credstore" }, runCommand);

  await provider.put("secret-a", "alpha-value");
  await provider.put("secret-b", "beta-value");

  assertEquals(await provider.get("secret-a"), "value-for-secret-a");
  assertEquals(await provider.get("secret-b"), "value-for-secret-b");
});

Deno.test("tilde expansion in credstoreDir", () => {
  const home = Deno.env.get("HOME")!;
  const runCommand: RunCommand = async (args) => {
    assertEquals(args[1], `${home}/my-creds/test.cred`);
    return { stdout: "ok", stderr: "", code: 0 };
  };
  const provider = vault.createProvider("test-vault", { credstoreDir: "~/my-creds" }, runCommand);
  assertEquals(provider.getName(), "test-vault");
});

Deno.test("assertSafeSecretKey accepts ordinary keys", () => {
  for (const k of ["MY_API_KEY", "garmin-secrets", "a.b.c", "key_123"]) {
    assertSafeSecretKey(k);
  }
});

Deno.test("assertSafeSecretKey rejects path-traversal and separators", () => {
  for (const k of ["../escape", "a/b", "a\\b", "", "nul\0byte", ".."]) {
    let threw = false;
    try {
      assertSafeSecretKey(k);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected ${JSON.stringify(k)} to be rejected`);
  }
});

Deno.test("put rejects a traversal key before touching the filesystem", async () => {
  let ran = false;
  const runCommand: RunCommand = async () => {
    ran = true;
    return { stdout: "", stderr: "", code: 0 };
  };
  const provider = vault.createProvider(
    "test-vault",
    { credstoreDir: "/tmp/test-credstore" },
    runCommand,
  );
  await assertRejects(
    () => provider.put("../../escape", "secret"),
    Error,
    "Invalid secret key",
  );
  assertEquals(ran, false);
});

Deno.test("get rejects a traversal key", async () => {
  const runCommand: RunCommand = async () => {
    return { stdout: "leaked", stderr: "", code: 0 };
  };
  const provider = vault.createProvider(
    "test-vault",
    { credstoreDir: "/tmp/test-credstore" },
    runCommand,
  );
  await assertRejects(
    () => provider.get("../../escape"),
    Error,
    "Invalid secret key",
  );
});

Deno.test("defaultRunCommand swallows a broken pipe and returns systemd's exit", async () => {
  // `true` exits immediately without reading stdin, so a large write raises
  // BrokenPipe. The runner must swallow it, still reap the child, and return
  // the real exit code — not reject with an opaque BrokenPipe.
  const { defaultRunCommand } = await import("./mod.ts");
  const result = await defaultRunCommand(
    ["encrypt", "-", "/tmp/x.cred"],
    "a".repeat(5_000_000),
    "true",
  );
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "");
});

Deno.test("defaultRunCommand reports systemd's failure and stderr", async () => {
  const { defaultRunCommand } = await import("./mod.ts");
  // `false` exits 1 without reading stdin; the failure code and stderr survive.
  const result = await defaultRunCommand(
    ["encrypt", "-", "/tmp/x.cred"],
    "value",
    "false",
  );
  assertEquals(result.code, 1);
});

Deno.test("provider surfaces systemd's message, not BrokenPipe, on early exit", async () => {
  const { vault } = await import("./mod.ts");
  // The injected runner models systemd-creds failing before reading stdin.
  const runCommand: RunCommand = async () => ({
    stdout: "",
    stderr: "Plaintext too long for credential (allowed size: 1048576).",
    code: 1,
  });
  const provider = vault.createProvider(
    "test-vault",
    { credstoreDir: "/tmp/test-credstore" },
    runCommand,
  );
  await assertRejects(
    () => provider.put("big", "x"),
    Error,
    "Plaintext too long",
  );
});
