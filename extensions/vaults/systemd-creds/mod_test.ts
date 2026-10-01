import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { assertSafeSecretKey, assertSafeVaultName, vault } from "./mod.ts";

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
  assertEquals(schema.parse({}), {
    credstoreDir: "~/.config/credstore",
    global: false,
  });
  assertEquals(schema.parse({ credstoreDir: "/custom/path" }), {
    credstoreDir: "/custom/path",
    global: false,
  });
  assertEquals(schema.parse({ global: true }), {
    credstoreDir: "~/.config/credstore",
    global: true,
  });
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

Deno.test("put stores the secret in the vault's own subdirectory", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const runCommand: RunCommand = async (args, stdin) => {
    calls.push({ args, stdin });
    return { stdout: "", stderr: "", code: 0 };
  };

  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/test-credstore" }, runCommand);
  await provider.put("my-key", "my-secret-value");

  assertEquals(calls.length, 1);
  assertEquals(calls[0].args, [
    "encrypt",
    "-",
    "/tmp/test-credstore/test-vault/my-key.cred",
  ]);
  assertEquals(calls[0].stdin, "my-secret-value");
});

Deno.test("put with global:true writes to the shared base directory", async () => {
  const calls: { args: string[] }[] = [];
  const runCommand: RunCommand = async (args) => {
    calls.push({ args });
    return { stdout: "", stderr: "", code: 0 };
  };
  const provider = vault.createProvider(
    "legacy",
    { credstoreDir: "/tmp/test-credstore", global: true },
    runCommand,
  );
  await provider.put("k", "v");
  assertEquals(calls[0].args, ["encrypt", "-", "/tmp/test-credstore/k.cred"]);
});

Deno.test("get resolves a key from the vault's own subdirectory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    await Deno.mkdir(`${tmpDir}/test-vault`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/test-vault/my-key.cred`, "encrypted");
    const runCommand: RunCommand = async (args) => {
      assertEquals(args, [
        "decrypt",
        `${tmpDir}/test-vault/my-key.cred`,
        "-",
      ]);
      return { stdout: "decrypted-value", stderr: "", code: 0 };
    };
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
      runCommand,
    );
    assertEquals(await provider.get("my-key"), "decrypted-value");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("get falls back to the shared global directory for a legacy key", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    // The key exists only in the flat, pre-isolation location.
    await Deno.writeTextFile(`${tmpDir}/legacy-key.cred`, "encrypted");
    const runCommand: RunCommand = async (args) => {
      assertEquals(args, ["decrypt", `${tmpDir}/legacy-key.cred`, "-"]);
      return { stdout: "old-value", stderr: "", code: 0 };
    };
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
      runCommand,
    );
    assertEquals(await provider.get("legacy-key"), "old-value");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("own directory shadows the shared global directory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    await Deno.mkdir(`${tmpDir}/test-vault`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/test-vault/k.cred`, "own");
    await Deno.writeTextFile(`${tmpDir}/k.cred`, "global");
    const runCommand: RunCommand = async (args) => {
      assertEquals(args[1], `${tmpDir}/test-vault/k.cred`);
      return { stdout: "own", stderr: "", code: 0 };
    };
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
      runCommand,
    );
    assertEquals(await provider.get("k"), "own");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

/** A runner that writes/reads real files so put→get/list works on disk. */
function fsRunner(): RunCommand {
  return async (args, stdin) => {
    if (args[0] === "encrypt") {
      await Deno.writeTextFile(args[2], stdin ?? "");
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "decrypt") {
      try {
        return {
          stdout: await Deno.readTextFile(args[1]),
          stderr: "",
          code: 0,
        };
      } catch {
        return { stdout: "", stderr: "not found", code: 1 };
      }
    }
    return { stdout: "", stderr: "unexpected", code: 1 };
  };
}

Deno.test("two vaults are isolated and do not share keys", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    const providerA = vault.createProvider(
      "vault-a",
      { credstoreDir: tmpDir },
      fsRunner(),
    );
    const providerB = vault.createProvider(
      "vault-b",
      { credstoreDir: tmpDir },
      fsRunner(),
    );
    await providerA.put("only-a", "va");
    await providerB.put("only-b", "vb");

    assertEquals(await providerA.list(), ["only-a"]);
    assertEquals(await providerB.list(), ["only-b"]);
    assertEquals(await providerA.get("only-a"), "va");
    assertEquals(await providerB.get("only-b"), "vb");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("list returns only the vault's own keys, not the shared global ones", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    await Deno.mkdir(`${tmpDir}/test-vault`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/test-vault/own.cred`, "x");
    // A legacy global key must NOT appear in a per-vault listing.
    await Deno.writeTextFile(`${tmpDir}/legacy.cred`, "y");
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
    );
    assertEquals(await provider.list(), ["own"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("a global:true vault lists the shared directory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    await Deno.writeTextFile(`${tmpDir}/legacy.cred`, "y");
    await Deno.mkdir(`${tmpDir}/per-vault`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/per-vault/own.cred`, "x");
    const provider = vault.createProvider(
      "legacy",
      { credstoreDir: tmpDir, global: true },
    );
    assertEquals(await provider.list(), ["legacy"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("delete removes a key from the vault's own directory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    await Deno.mkdir(`${tmpDir}/test-vault`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/test-vault/k.cred`, "x");
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
    );
    await provider.delete("k");
    assertEquals(await provider.list(), []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("delete is a no-op for a key that is already absent", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
    );
    await provider.delete!("does-not-exist");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("delete refuses a key that lives only in the shared global dir", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    await Deno.writeTextFile(`${tmpDir}/shared.cred`, "x");
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
    );
    await assertRejects(
      () => provider.delete!("shared"),
      Error,
      "shared global credstore",
    );
    // The global file is untouched.
    assertEquals(
      await Deno.stat(`${tmpDir}/shared.cred`).then(() => true),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("provider exposes a delete method so swamp supports vault delete", () => {
  const provider = vault.createProvider("v", {});
  assertEquals(typeof provider.delete, "function");
});

Deno.test("a vault name that could escape the base dir is rejected", () => {
  for (const n of ["../escape", "a/b", "a\\b", "", "nul\0byte"]) {
    let threw = false;
    try {
      assertSafeVaultName(n);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected ${JSON.stringify(n)} to be rejected`);
  }
});

Deno.test("createProvider rejects a traversal vault name", () => {
  let threw = false;
  try {
    vault.createProvider("../../etc", { credstoreDir: "/tmp/x" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("get throws on decrypt failure", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    await Deno.mkdir(`${tmpDir}/test-vault`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/test-vault/bad-key.cred`, "junk");
    const runCommand: RunCommand = async () => {
      return { stdout: "", stderr: "decryption failed: bad key", code: 1 };
    };
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
      runCommand,
    );
    await assertRejects(
      () => provider.get("bad-key"),
      Error,
      "decryption failed: bad key",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("get throws when the key is absent from both dirs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-cred-" });
  try {
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
    );
    await assertRejects(
      () => provider.get("missing"),
      Error,
      "not found",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
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

Deno.test("list returns sorted keys from the vault's own subdirectory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-credstore-" });
  try {
    await Deno.mkdir(`${tmpDir}/test-vault`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/test-vault/beta.cred`, "encrypted");
    await Deno.writeTextFile(`${tmpDir}/test-vault/alpha.cred`, "encrypted");
    await Deno.writeTextFile(`${tmpDir}/test-vault/not-a-cred.txt`, "plain");

    const provider = vault.createProvider("test-vault", { credstoreDir: tmpDir });
    const keys = await provider.list();

    assertEquals(keys, ["alpha", "beta"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("list returns empty array for a missing vault dir", async () => {
  const provider = vault.createProvider("test-vault", { credstoreDir: "/tmp/nonexistent-dir-xyz" });
  const keys = await provider.list();
  assertEquals(keys, []);
});

Deno.test("getName returns vault name", () => {
  const provider = vault.createProvider("my-vault-name", {});
  assertEquals(provider.getName(), "my-vault-name");
});

Deno.test("put/get roundtrip through the vault subdirectory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-test-credstore-" });
  try {
    const provider = vault.createProvider(
      "test-vault",
      { credstoreDir: tmpDir },
      fsRunner(),
    );
    await provider.put("secret-a", "alpha-value");
    await provider.put("secret-b", "beta-value");

    assertEquals(await provider.get("secret-a"), "alpha-value");
    assertEquals(await provider.get("secret-b"), "beta-value");
    // Both landed in the per-vault subdirectory, not the base dir.
    assertEquals(
      await Deno.stat(`${tmpDir}/test-vault/secret-a.cred`).then(() => true),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
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
