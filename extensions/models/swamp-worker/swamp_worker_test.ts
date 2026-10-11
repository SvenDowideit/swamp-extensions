import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertOwnedUnit,
  assertValidUnitName,
  baseLabels,
  cacheDirFor,
  deriveUnitName,
  envFilePath,
  renderWorkerUnit,
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
