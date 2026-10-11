import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  assertOwnedUnit,
  assertValidUnitName,
  baseLabels,
  cacheDirFor,
  type CmdResult,
  deriveUnitName,
  envFilePath,
  HOSTNAME_PLACEHOLDER,
  model,
  renderProvisionScript,
  renderRemoveScript,
  renderWorkerUnit,
  setRunFn,
  stagedTokenPath,
  tokenFilePath,
  unitPathFor,
} from "./swamp_worker.ts";

const G = {
  identity: "figy",
  unitName: "",
  unitDir: "~/.config/systemd/user",
  configDir: "~/.config/swamp-worker",
  cacheDirRoot: "~/.local/share/swamp-worker",
};

Deno.test("deriveUnitName namespaces by identity", () => {
  assertEquals(deriveUnitName("figy"), "swamp-worker-figy");
  assertEquals(deriveUnitName("rc"), "swamp-worker-rc");
});

Deno.test("deriveUnitName honours an explicit override", () => {
  assertEquals(
    deriveUnitName("figy", "swamp-worker-custom"),
    "swamp-worker-custom",
  );
});

Deno.test("assertOwnedUnit accepts this identity's unit and rejects foreign ones", () => {
  assertOwnedUnit("swamp-worker-figy", "figy");
  assertThrows(() => assertOwnedUnit("swamp-worker-rc", "figy"));
  assertThrows(() => assertOwnedUnit("swamp-worker", "figy"));
  assertThrows(() => assertOwnedUnit("swamp-serve", "figy"));
});

Deno.test("path helpers namespace every artifact and expand ~", () => {
  assertEquals(
    unitPathFor(G, "/home/sven"),
    "/home/sven/.config/systemd/user/swamp-worker-figy.service",
  );
  assertEquals(
    tokenFilePath(G as never, "/home/sven"),
    "/home/sven/.config/swamp-worker/figy.token",
  );
  assertEquals(
    envFilePath(G as never, "/home/sven"),
    "/home/sven/.config/swamp-worker/figy.env",
  );
  assertEquals(
    cacheDirFor(G as never, "/home/sven"),
    "/home/sven/.local/share/swamp-worker/figy",
  );
});

Deno.test("baseLabels advertises serve + host", () => {
  assertEquals(baseLabels("figy", "x1yoga.fi.gy"), [
    ["serve", "figy"],
    ["host", "x1yoga.fi.gy"],
  ]);
});

Deno.test("renderWorkerUnit renders a connect unit with namespaced artifacts", () => {
  const unit = renderWorkerUnit({
    unitName: "swamp-worker-figy",
    identity: "figy",
    serveUrl: "wss://swamp.x1yoga.fi.gy",
    swampBinPath: "/usr/local/bin/swamp",
    tokenFile: "/root/.config/swamp-worker/figy.token",
    cacheDir: "/root/.local/share/swamp-worker/figy",
    concurrency: "auto",
    swampHome: "/root/.swamp",
    swampConfigDir: "/root/.config/swamp",
    envFile: "/root/.config/swamp-worker/figy.env",
    labels: baseLabels("figy", "x1yoga.fi.gy"),
  });
  assert(
    unit.includes(
      "ExecStart=/usr/local/bin/swamp worker connect wss://swamp.x1yoga.fi.gy",
    ),
  );
  assert(unit.includes("--token-file /root/.config/swamp-worker/figy.token"));
  assert(unit.includes("--cache-dir /root/.local/share/swamp-worker/figy"));
  assert(unit.includes("--concurrency auto"));
  assert(unit.includes("--label serve=figy"));
  assert(unit.includes("--label host=x1yoga.fi.gy"));
  assert(unit.includes("Environment=SWAMP_HOME=/root/.swamp"));
  assert(unit.includes("Environment=SWAMP_CONFIG_DIR=/root/.config/swamp"));
  assert(unit.includes("EnvironmentFile=-/root/.config/swamp-worker/figy.env"));
  assert(unit.includes("Restart=always"));
  assert(unit.includes("WantedBy=default.target"));
});

Deno.test("renderWorkerUnit omits EnvironmentFile when none is given", () => {
  const unit = renderWorkerUnit({
    unitName: "swamp-worker-figy",
    identity: "figy",
    serveUrl: "ws://127.0.0.1:9090",
    swampBinPath: "/usr/local/bin/swamp",
    tokenFile: "/t/figy.token",
    cacheDir: "/c/figy",
    concurrency: "2",
    swampHome: "/h",
    swampConfigDir: "/cfg",
  });
  assert(!unit.includes("EnvironmentFile"));
  assert(unit.includes("--concurrency 2"));
  assert(!unit.includes("--label"));
});

Deno.test("renderWorkerUnit quotes and rejects injection", () => {
  const unit = renderWorkerUnit({
    unitName: "swamp-worker-figy",
    identity: "figy",
    serveUrl: "wss://swamp.example.com",
    swampBinPath: "/usr/local/bin/swamp",
    tokenFile: "/t/figy.token",
    cacheDir: "/c/figy",
    concurrency: "auto",
    swampHome: "/h",
    swampConfigDir: "/cfg",
    labels: [["tier", "the value"]],
  });
  assert(unit.includes(`--label 'tier=the value'`));

  assertThrows(() =>
    renderWorkerUnit({
      unitName: "swamp-worker-figy",
      identity: "figy",
      serveUrl: "wss://x\nExecStartPre=/evil",
      swampBinPath: "/usr/local/bin/swamp",
      tokenFile: "/t/figy.token",
      cacheDir: "/c/figy",
      concurrency: "auto",
      swampHome: "/h",
      swampConfigDir: "/cfg",
    })
  );
});

Deno.test("assertValidUnitName rejects path-unsafe names", () => {
  assertValidUnitName("swamp-worker-figy");
  assertThrows(() => assertValidUnitName("swamp-worker/../evil"));
  assertThrows(() => assertValidUnitName("has space"));
  assertThrows(() => assertValidUnitName(""));
});

// ---------------------------------------------------------------------------
// Execute-level tests: the methods driven with a stubbed subprocess runner and
// a temp directory tree, so install/mint/ensure/status/remove/revoke are proven
// without touching a real host.
// ---------------------------------------------------------------------------

const SERVE = "ws://127.0.0.1:9090";

type Exec = (
  args: Record<string, unknown>,
  ctx: unknown,
) => Promise<{ dataHandles: unknown[] }>;
const methods = model.methods as unknown as Record<string, { execute: Exec }>;

function globals(tmp: string): Record<string, unknown> {
  return {
    identity: "figy",
    unitName: "",
    swampBinPath: `${tmp}/bin/swamp`,
    repoDir: `${tmp}/repo`,
    configDir: `${tmp}/config`,
    cacheDirRoot: `${tmp}/cache`,
    stagingDir: `${tmp}/staging`,
    unitDir: `${tmp}/units`,
    swampHome: `${tmp}/home`,
    swampConfigDir: `${tmp}/cfg`,
    releaseBaseUrl: "https://example.test/releases",
    concurrency: "auto",
    enableLinger: true,
  };
}

function fakeContext(g: Record<string, unknown>) {
  const writes: Array<{ resource: string; instance: string; data: unknown }> =
    [];
  return {
    writes,
    ctx: {
      globalArgs: g,
      writeResource: (resource: string, instance: string, data: unknown) => {
        writes.push({ resource, instance, data });
        return Promise.resolve({ name: instance });
      },
    },
  };
}

function recorder(
  handler?: (bin: string, args: string[]) => CmdResult | undefined,
) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fn = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return Promise.resolve(
      handler?.(bin, args) ?? { stdout: "", stderr: "", code: 0 },
    );
  };
  return { calls, fn };
}

async function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp-worker-test-" });
  try {
    await fn(tmp);
  } finally {
    setRunFn(null);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test("install reports kept when the binary is present", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    await Deno.mkdir(`${tmp}/bin`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/bin/swamp`, "#!/bin/sh\n");
    const { ctx, writes } = fakeContext(g);
    await methods.install.execute({ force: false }, ctx);
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.action, "kept");
    assertEquals(data.present, true);
  });
});

Deno.test("install downloads the binary when absent", async () => {
  await withTmp(async (tmp) => {
    // The runner stands in for `curl`: it creates the file named by `-o`.
    const rec = recorder((_bin, args) => {
      const i = args.indexOf("-o");
      if (i >= 0) Deno.writeTextFileSync(args[i + 1], "#!/bin/sh\n");
      return { stdout: "", stderr: "", code: 0 };
    });
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(globals(tmp));
    await methods.install.execute({ version: "", force: false }, ctx);
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.action, "installed");
    assertEquals(data.present, true);
    assert(rec.calls.some((c) => c.bin === "curl"));
  });
});

Deno.test("install reports failed when the download fails", async () => {
  await withTmp(async (tmp) => {
    const rec = recorder(() => ({ stdout: "", stderr: "boom", code: 1 }));
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(globals(tmp));
    await methods.install.execute({ version: "", force: false }, ctx);
    assertEquals(
      (writes[0].data as Record<string, unknown>).action,
      "failed",
    );
  });
});

Deno.test("clearStagedTokens removes the staging files", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    await Deno.mkdir(`${tmp}/staging`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/staging/figy-node1.token`, "x\n");
    await Deno.writeTextFile(`${tmp}/staging/figy-node2.token`, "y\n");
    await methods.clearStagedTokens.execute(
      { nodes: ["node1", "node2"] },
      fakeContext(g).ctx,
    );
    assertEquals(await exists(`${tmp}/staging/figy-node1.token`), false);
    assertEquals(await exists(`${tmp}/staging/figy-node2.token`), false);
  });
});

Deno.test("mintToken reuses an existing token without calling swamp", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    await Deno.mkdir(`${tmp}/config`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/config/figy.token`, "figy-old.secret\n");
    const rec = recorder();
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(g);
    await methods.mintToken.execute(
      { node: "testhost", duration: "1h", force: false },
      ctx,
    );
    assertEquals(rec.calls.length, 0);
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.reused, true);
    assertEquals(data.revoked, false);
  });
});

Deno.test("mintToken mints, writes the 0600 file, and never records the secret", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    const rec = recorder((_bin, args) =>
      args.includes("create")
        ? {
          stdout: JSON.stringify({ token: "figy-testhost.secret" }),
          stderr: "",
          code: 0,
        }
        : undefined
    );
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(g);
    await methods.mintToken.execute(
      { node: "testhost", duration: "1h", force: false },
      ctx,
    );
    assert(rec.calls.some((c) => c.args.includes("create")));
    const tokenFile = `${tmp}/config/figy.token`;
    assertEquals(
      (await Deno.readTextFile(tokenFile)).trim(),
      "figy-testhost.secret",
    );
    assertEquals((await Deno.stat(tokenFile)).mode! & 0o777, 0o600);
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.reused, false);
    assert(!JSON.stringify(data).includes("secret"));
  });
});

Deno.test("mintToken fails loudly when swamp cannot mint", async () => {
  await withTmp(async (tmp) => {
    const rec = recorder(() => ({ stdout: "", stderr: "boom", code: 1 }));
    setRunFn(rec.fn);
    await assertRejects(
      () =>
        methods.mintToken.execute(
          { node: "n", duration: "1h", force: false },
          fakeContext(globals(tmp)).ctx,
        ),
      Error,
      "token create",
    );
  });
});

Deno.test("ensureService is a no-op when the unit already matches", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    const expected = renderWorkerUnit({
      unitName: "swamp-worker-figy",
      identity: "figy",
      serveUrl: SERVE,
      swampBinPath: `${tmp}/bin/swamp`,
      tokenFile: `${tmp}/config/figy.token`,
      cacheDir: `${tmp}/cache/figy`,
      concurrency: "auto",
      swampHome: `${tmp}/home`,
      swampConfigDir: `${tmp}/cfg`,
      envFile: `${tmp}/config/figy.env`,
      labels: baseLabels("figy", "testhost"),
    });
    await Deno.mkdir(`${tmp}/units`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/units/swamp-worker-figy.service`,
      expected,
    );
    const rec = recorder((bin, args) =>
      bin === "systemctl" && args.includes("is-active")
        ? { stdout: "active\n", stderr: "", code: 0 }
        : undefined
    );
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(g);
    await methods.ensureService.execute(
      {
        serveUrl: SERVE,
        host: "testhost",
        labels: [],
        concurrency: "",
        force: false,
      },
      ctx,
    );
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.changed, false);
    assertEquals(data.restarted, false);
    assert(rec.calls.every((c) => !c.args.includes("daemon-reload")));
    assert(rec.calls.every((c) => !c.args.includes("restart")));
  });
});

Deno.test("ensureService writes, reloads, enables and starts on change", async () => {
  await withTmp(async (tmp) => {
    const rec = recorder(); // is-active defaults to "" (inactive)
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(globals(tmp));
    await methods.ensureService.execute(
      {
        serveUrl: SERVE,
        host: "testhost",
        labels: ["tier=prod"],
        concurrency: "",
        force: false,
      },
      ctx,
    );
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.changed, true);
    assertEquals(data.restarted, true);
    const argLines = rec.calls.map((c) => c.args.join(" "));
    assert(argLines.some((a) => a.includes("daemon-reload")));
    assert(argLines.some((a) => a.includes("enable swamp-worker-figy")));
    assert(argLines.some((a) => a.includes("start swamp-worker-figy")));
  });
});

Deno.test("ensureService restarts an already-active unit when it changes", async () => {
  await withTmp(async (tmp) => {
    const rec = recorder((bin, args) =>
      bin === "systemctl" && args.includes("is-active")
        ? { stdout: "active\n", stderr: "", code: 0 }
        : undefined
    );
    setRunFn(rec.fn);
    const { ctx } = fakeContext(globals(tmp));
    await methods.ensureService.execute(
      {
        serveUrl: SERVE,
        host: "testhost",
        labels: [],
        concurrency: "",
        force: false,
      },
      ctx,
    );
    const argLines = rec.calls.map((c) => c.args.join(" "));
    assert(argLines.some((a) => a.includes("restart swamp-worker-figy")));
  });
});

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true).catch(() => false);
}

Deno.test("remove revokes the token and deletes only this identity's artifacts", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    await Deno.mkdir(`${tmp}/units`, { recursive: true });
    await Deno.mkdir(`${tmp}/cache/figy`, { recursive: true });
    await Deno.mkdir(`${tmp}/config`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/units/swamp-worker-figy.service`,
      "[Unit]\n",
    );
    await Deno.writeTextFile(`${tmp}/config/figy.token`, "x\n");
    const rec = recorder();
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(g);
    await methods.remove.execute(
      { node: "testhost", revokeToken: true, purgeData: true },
      ctx,
    );
    // Complete decommission: the token is revoked before the unit is torn down.
    assert(
      rec.calls.some((c) =>
        c.args.includes("revoke") && c.args.includes("figy-testhost")
      ),
    );
    assert(
      rec.calls.some((c) =>
        c.args.includes("stop") && c.args.includes("swamp-worker-figy")
      ),
    );
    assertEquals(await exists(`${tmp}/units/swamp-worker-figy.service`), false);
    assertEquals(await exists(`${tmp}/cache/figy`), false);
    assertEquals(await exists(`${tmp}/config/figy.token`), false);
    assertEquals((writes[0].data as Record<string, unknown>).exists, false);
  });
});

Deno.test("remove skips revocation when revokeToken is false", async () => {
  await withTmp(async (tmp) => {
    const rec = recorder();
    setRunFn(rec.fn);
    await methods.remove.execute(
      { node: "testhost", revokeToken: false, purgeData: true },
      fakeContext(globals(tmp)).ctx,
    );
    assert(rec.calls.every((c) => !c.args.includes("revoke")));
    assert(rec.calls.some((c) => c.args.includes("stop")));
  });
});

Deno.test("remove completes even when the token is already gone", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    await Deno.mkdir(`${tmp}/units`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/units/swamp-worker-figy.service`,
      "[Unit]\n",
    );
    const rec = recorder((_bin, args) =>
      args.includes("revoke")
        ? { stdout: "", stderr: "token not found", code: 1 }
        : undefined
    );
    setRunFn(rec.fn);
    await methods.remove.execute(
      { node: "testhost", revokeToken: true, purgeData: true },
      fakeContext(g).ctx,
    );
    assertEquals(await exists(`${tmp}/units/swamp-worker-figy.service`), false);
  });
});

Deno.test("remove refuses a unit that is not this identity's own", async () => {
  await withTmp(async (tmp) => {
    const g = { ...globals(tmp), unitName: "swamp-worker-rc" };
    await assertRejects(
      () => methods.remove.execute({ purgeData: true }, fakeContext(g).ctx),
      Error,
      "Refusing",
    );
  });
});

Deno.test("status reports the unit and this identity's enrolled workers", async () => {
  await withTmp(async (tmp) => {
    const rec = recorder((bin, args) => {
      if (bin === "systemctl" && args.includes("is-active")) {
        return { stdout: "active\n", stderr: "", code: 0 };
      }
      if (args.includes("worker") && args.includes("list")) {
        return {
          stdout: JSON.stringify({
            workers: [
              { name: "figy-testhost", labels: { serve: "figy" } },
              { name: "rc-testhost", labels: { serve: "rc" } },
            ],
            count: 2,
          }),
          stderr: "",
          code: 0,
        };
      }
      return undefined;
    });
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(globals(tmp));
    await methods.status.execute({}, ctx);
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.active, true);
    assertEquals(data.enrolledWorkers, 2);
    assertEquals(data.matchingWorkers, ["figy-testhost"]);
  });
});

Deno.test("revokeToken revokes and removes the local token file", async () => {
  await withTmp(async (tmp) => {
    await Deno.mkdir(`${tmp}/config`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/config/figy.token`,
      "figy-testhost.secret\n",
    );
    const rec = recorder();
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(globals(tmp));
    await methods.revokeToken.execute(
      { node: "testhost", purgeFile: true },
      ctx,
    );
    assert(
      rec.calls.some((c) =>
        c.args.includes("revoke") && c.args.includes("figy-testhost")
      ),
    );
    assertEquals(
      await Deno.stat(`${tmp}/config/figy.token`).then(() => true).catch(() =>
        false
      ),
      false,
    );
    const data = writes[0].data as Record<string, unknown>;
    assertEquals(data.revoked, true);
    assertEquals(data.name, "figy-testhost");
  });
});

Deno.test("revokeToken fails loudly when swamp cannot revoke", async () => {
  await withTmp(async (tmp) => {
    const rec = recorder(() => ({ stdout: "", stderr: "nope", code: 1 }));
    setRunFn(rec.fn);
    await assertRejects(
      () =>
        methods.revokeToken.execute(
          { node: "testhost", purgeFile: false },
          fakeContext(globals(tmp)).ctx,
        ),
      Error,
      "token revoke",
    );
  });
});

// ---------------------------------------------------------------------------
// Provision / remove script renderers, and orchestrator-side token staging.
// ---------------------------------------------------------------------------

const PROVISION = {
  unitName: "swamp-worker-figy",
  unitContent: renderWorkerUnit({
    unitName: "swamp-worker-figy",
    identity: "figy",
    serveUrl: "wss://swamp.x1yoga.fi.gy",
    swampBinPath: "/usr/local/bin/swamp",
    tokenFile: "/root/.config/swamp-worker/figy.token",
    cacheDir: "/root/.local/share/swamp-worker/figy",
    concurrency: "auto",
    swampHome: "/root/.swamp",
    swampConfigDir: "/root/.config/swamp",
    envFile: "/root/.config/swamp-worker/figy.env",
    labels: [["serve", "figy"], ["host", HOSTNAME_PLACEHOLDER]],
  }),
  swampBinPath: "/usr/local/bin/swamp",
  configDir: "/root/.config/swamp-worker",
  cacheDir: "/root/.local/share/swamp-worker/figy",
  tokenFile: "/root/.config/swamp-worker/figy.token",
  envFile: "/root/.config/swamp-worker/figy.env",
  unitDir: "/root/.config/systemd/user",
  swampHome: "/root/.swamp",
  swampConfigDir: "/root/.config/swamp",
  releaseBaseUrl: "https://github.com/swamp-club/swamp/releases",
  enableLinger: true,
};

Deno.test("renderProvisionScript installs, locks the token, and starts the unit", () => {
  const s = renderProvisionScript(PROVISION);
  assert(s.startsWith("#!/bin/sh"));
  assert(s.includes("set -eu"));
  assert(s.includes("latest/download/swamp-linux-$ARCH"));
  assert(s.includes('chmod 600 "$TOKEN_FILE"'));
  assert(s.includes("systemctl --user daemon-reload"));
  assert(s.includes('systemctl --user enable "$UNIT_NAME"'));
  assert(s.includes('systemctl --user restart "$UNIT_NAME"'));
  assert(s.includes("loginctl enable-linger"));
  assert(s.includes("--label serve=figy"));
  assert(s.includes(HOSTNAME_PLACEHOLDER));
  assert(s.includes(`sed "s/${HOSTNAME_PLACEHOLDER}/$HOST/g"`));
  assert(s.includes("HOST=$(hostname"));
});

Deno.test("renderProvisionScript pins a requested swamp version", () => {
  const s = renderProvisionScript({ ...PROVISION, version: "1.2.3" });
  assert(s.includes("download/1.2.3/swamp-linux-$ARCH"));
});

Deno.test("renderProvisionScript omits linger when disabled", () => {
  const s = renderProvisionScript({ ...PROVISION, enableLinger: false });
  assert(!s.includes("loginctl enable-linger"));
});

Deno.test("renderProvisionScript rejects a unit containing the heredoc terminator", () => {
  assertThrows(() =>
    renderProvisionScript({ ...PROVISION, unitContent: "x\nTF_UNIT_EOF\ny" })
  );
});

Deno.test("renderRemoveScript stops, disables and deletes the artifacts", () => {
  const s = renderRemoveScript({
    unitName: "swamp-worker-figy",
    unitDir: "/root/.config/systemd/user",
    configDir: "/root/.config/swamp-worker",
    cacheDir: "/root/.local/share/swamp-worker/figy",
    tokenFile: "/root/.config/swamp-worker/figy.token",
    envFile: "/root/.config/swamp-worker/figy.env",
  });
  assert(s.includes('systemctl --user stop "$UNIT_NAME"'));
  assert(s.includes('systemctl --user disable "$UNIT_NAME"'));
  assert(s.includes('rm -f "$UNIT_FILE"'));
  assert(s.includes("/root/.local/share/swamp-worker/figy"));
  assert(s.includes("/root/.config/swamp-worker/figy.token"));
});

Deno.test("stagedTokenPath namespaces the staging file per node", () => {
  const g = {
    identity: "figy",
    stagingDir: "~/.local/share/swamp-worker/staging",
  };
  assertEquals(
    stagedTokenPath(g as never, "web-1", "/root"),
    "/root/.local/share/swamp-worker/staging/figy-web-1.token",
  );
});

Deno.test("stageTokens mints one token per node into 0600 staging files", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    const rec = recorder((_bin, args) => {
      const name = args[args.indexOf("create") + 1];
      return {
        stdout: JSON.stringify({ token: `${name}.secret` }),
        stderr: "",
        code: 0,
      };
    });
    setRunFn(rec.fn);
    const { ctx, writes } = fakeContext(g);
    await methods.stageTokens.execute(
      { nodes: ["web-1", "web-2"], duration: "1h" },
      ctx,
    );
    const a = `${tmp}/staging/figy-web-1.token`;
    const b = `${tmp}/staging/figy-web-2.token`;
    assertEquals((await Deno.readTextFile(a)).trim(), "figy-web-1.secret");
    assertEquals((await Deno.readTextFile(b)).trim(), "figy-web-2.secret");
    assertEquals((await Deno.stat(a)).mode! & 0o777, 0o600);
    const data = writes[0].data as {
      tokens: Array<{ node: string; path: string }>;
    };
    assertEquals(data.tokens.map((t) => t.node), ["web-1", "web-2"]);
    assert(!JSON.stringify(data).includes("secret"));
  });
});

Deno.test("stageTokens requires at least one node", async () => {
  await withTmp(async (tmp) => {
    await assertRejects(
      () =>
        methods.stageTokens.execute(
          { nodes: [], duration: "1h" },
          fakeContext(globals(tmp)).ctx,
        ),
      Error,
      "at least one node",
    );
  });
});

Deno.test("renderProvision records a script with the per-node hostname placeholder", async () => {
  await withTmp(async (tmp) => {
    const { ctx, writes } = fakeContext(globals(tmp));
    await methods.renderProvision.execute(
      {
        serveUrl: "wss://swamp.example.com",
        host: "",
        labels: ["tier=prod"],
        concurrency: "",
        version: "1.2.3",
      },
      ctx,
    );
    const data = writes[0].data as { script: string; unitContent: string };
    assert(data.script.includes("download/1.2.3/swamp-linux-$ARCH"));
    assert(data.script.includes(HOSTNAME_PLACEHOLDER));
    assert(data.unitContent.includes(HOSTNAME_PLACEHOLDER));
    assert(data.unitContent.includes("--label serve=figy"));
    assert(data.unitContent.includes("tier=prod"));
    assert(data.script.includes(data.unitContent));
  });
});

Deno.test("stageTokens reuses a staged token unless force", async () => {
  await withTmp(async (tmp) => {
    const g = globals(tmp);
    const rec = recorder((_b, args) =>
      args.includes("create")
        ? {
          stdout: JSON.stringify({ token: "prov-node1.secret" }),
          stderr: "",
          code: 0,
        }
        : undefined
    );
    setRunFn(rec.fn);
    await methods.stageTokens.execute(
      { nodes: ["node1"], duration: "1h", force: false },
      fakeContext(g).ctx,
    );
    const creates1 = rec.calls.filter((c) => c.args.includes("create")).length;
    const second = fakeContext(g);
    await methods.stageTokens.execute(
      { nodes: ["node1"], duration: "1h", force: false },
      second.ctx,
    );
    assertEquals(
      rec.calls.filter((c) => c.args.includes("create")).length,
      creates1,
    );
    const data = second.writes[0].data as {
      tokens: Array<{ reused: boolean }>;
    };
    assertEquals(data.tokens[0].reused, true);
  });
});

Deno.test("renderProvisionScript restarts on a token change and gates on active", () => {
  const s = renderProvisionScript(PROVISION);
  assert(s.includes("TOKEN_STAMP"));
  assert(s.includes("sha256sum"));
  assert(s.includes("is not active on this host"));
  assert(s.includes("exit 1"));
});
