import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildProbeRunScript,
  buildProbeWorkflow,
  buildServeScript,
  buildTokenScript,
  buildWorkerScript,
  REMOTE_MARKER,
} from "./topology.ts";

const cfg = {
  repoDir: "/work/repo",
  port: 9090,
  sharedDir: "/tf-shared",
  workerCount: 2,
};

Deno.test("buildServeScript starts serve on loopback and waits for ready", () => {
  const s = buildServeScript(cfg);
  assertStringIncludes(s, "swamp serve --host 127.0.0.1 --port 9090");
  assertStringIncludes(s, "--auth-mode none");
  assertStringIncludes(s, "http://127.0.0.1:9090/ready");
  assertStringIncludes(s, "SERVE_READY");
});

Deno.test("buildTokenScript mints one token per worker", () => {
  const s = buildTokenScript(cfg);
  assertStringIncludes(s, 'swamp worker token create "tf-w$i"');
  assertStringIncludes(s, "--duration 1h");
  assertStringIncludes(s, "tokens.txt");
});

Deno.test("buildWorkerScript installs swamp, selects its token, labels itself", () => {
  const s = buildWorkerScript({
    url: "ws://127.0.0.1:9090",
    sharedDir: "/tf-shared",
    index: 2,
    labels: { pool: "tf" },
    releaseBaseUrl: "https://example.test/releases",
    swampVersion: "v1.2.3",
  });
  assertStringIncludes(s, "swamp-linux-$SWAMP_ARCH");
  assertStringIncludes(s, "download/v1.2.3/swamp-linux-");
  assertStringIncludes(s, 'sed -n "2p"');
  assertStringIncludes(s, "swamp worker connect 'ws://127.0.0.1:9090'");
  assertStringIncludes(s, "--label 'pool=tf'");
  assertStringIncludes(s, "--cache-dir '/work/wcache-2'");
});

Deno.test("the probe workflow places its step when asked", () => {
  const placed = buildProbeWorkflow(true);
  assertStringIncludes(placed, "labels:\n  pool: tf");
  assertStringIncludes(placed, "echo TF_REMOTE_OK");
  const local = buildProbeWorkflow(false);
  assertEquals(local.includes("pool: tf"), false);
  assertStringIncludes(local, "echo TF_REMOTE_OK");
});

Deno.test("the probe run script runs through serve", () => {
  const s = buildProbeRunScript(cfg, true);
  assertStringIncludes(s, "cat > workflows/workflow-tf-probe.yaml");
  assertStringIncludes(
    s,
    "swamp workflow run tf-probe --server 'ws://127.0.0.1:9090'",
  );
});

Deno.test("REMOTE_MARKER is the string the probe prints", () => {
  assertEquals(REMOTE_MARKER, "TF_REMOTE_OK");
  assertStringIncludes(buildProbeWorkflow(true), REMOTE_MARKER);
});
