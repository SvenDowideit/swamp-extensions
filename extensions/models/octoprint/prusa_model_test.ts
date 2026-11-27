/**
 * Method-level tests for `@svendowideit/prusa`.
 *
 * Every method runs against a stubbed fetch and a fake vault, so no printer,
 * network or credential is needed. Parsers are covered in `prusa_test.ts`; this
 * file covers the wiring and the honest-empty paths.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { model } from "./prusa_model.ts";

const GLOBALS = {
  name: "mk2s-prusa",
  baseUrl: "",
  vaultName: "octoprint-secrets",
  urlRef: "url",
  requestTimeoutMs: 5000,
  firmwareRepo: "prusa3d/Prusa-Firmware",
  githubToken: "",
  darkBytesPerPixel: 0.05,
  userAgent: "swamp-prusa-test/1.0",
};

/** A fake vault that supplies only the endpoint. */
const VAULT = {
  get: (vault: string, key: string) =>
    Promise.resolve(
      vault === "octoprint-secrets" && key === "url"
        ? "http://10.10.3.253"
        : undefined,
    ),
};

function withVault(ctx: { context: unknown }): void {
  (ctx.context as { vaultService?: unknown }).vaultService = VAULT;
}

/** A minimal valid 640x480 JPEG header plus padding. */
function jpeg(padTo: number): Uint8Array {
  const header = Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x01,
    0xe0,
    0x02,
    0x80,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  const out = new Uint8Array(padTo);
  out.set(header);
  return out;
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(
      handler(typeof input === "string" ? input : input.toString()),
    )) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

type Executable = {
  execute: (a: Record<string, unknown>, c: unknown) => Promise<unknown>;
};

async function call(
  method: string,
  args: Record<string, unknown>,
  ctx: { context: unknown },
): Promise<void> {
  const m = (model.methods as unknown as Record<string, Executable>)[method];
  await m.execute(args, ctx.context);
}

Deno.test("firmwareCheck reports an unpublished line instead of 'behind'", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "firmwareCheck",
  });
  withVault(ctx);
  const restore = stubFetch(() =>
    new Response(
      JSON.stringify([
        { tag_name: "3.14.1", prerelease: false, published_at: "2024-11-28" },
        { tag_name: "3.13.3", prerelease: false },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  try {
    await call(
      "firmwareCheck",
      { firmwareName: "Prusa-Firmware 3.2.3 based on Marlin" },
      ctx,
    );
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.installedVersion, "3.2.3");
  assertEquals(d.latestTag, "3.14.1");
  assertEquals(d.verdict, "unpublished-line");
  assertEquals(d.repo, "prusa3d/Prusa-Firmware");
  // The real MK2S string carries no build date, so this stays empty and honest.
  assertEquals(d.installedBuildDate, "");
  assertEquals(d.comparedToPublishedAt, "");
  assertEquals(d.errors, []);
});

Deno.test("firmwareCheck dates both sides when the line is published", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "firmwareCheck",
  });
  withVault(ctx);
  const restore = stubFetch(() =>
    new Response(
      JSON.stringify([
        { tag_name: "3.13.3", published_at: "2024-11-28T12:42:21Z" },
        { tag_name: "3.13.2", published_at: "2024-06-01T00:00:00Z" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );
  try {
    await call(
      "firmwareCheck",
      { firmwareName: "Prusa-Firmware 3.13.2 (2024-06-01)" },
      ctx,
    );
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.installedVersion, "3.13.2");
  assertEquals(d.installedBuildDate, "2024-06-01");
  assertEquals(d.verdict, "behind");
  assertEquals(d.comparedTo, "3.13.3");
  assertEquals(d.comparedToPublishedAt, "2024-11-28T12:42:21Z");
});

Deno.test("firmwareCheck reports unknown when no releases come back", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "firmwareCheck",
  });
  withVault(ctx);
  const restore = stubFetch(() =>
    new Response(JSON.stringify([]), { status: 200 })
  );
  try {
    await call(
      "firmwareCheck",
      {
        logText:
          'octoprint.util.comm - INFO - Printer reports firmware name "Prusa-Firmware 3.2.3 based on Marlin"',
      },
      ctx,
    );
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.installedVersion, "3.2.3");
  assertEquals(d.verdict, "unknown");
});

Deno.test("firmwareCheck records a fetch failure in errors, not by throwing", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "firmwareCheck",
  });
  withVault(ctx);
  const restore = stubFetch(() => new Response("nope", { status: 404 }));
  try {
    await call("firmwareCheck", { firmwareName: "3.2.3" }, ctx);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals((d.errors as string[]).length, 1);
  assertEquals(d.verdict, "unknown");
});

Deno.test("config says so when no M503 was ever logged", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "config" });
  withVault(ctx);
  await call("config", { logText: "nothing but chatter here" }, ctx);
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.found, false);
  assertEquals((d.notes as string[]).length, 1);
  assertEquals(typeof d.hash, "string");
});

Deno.test("config parses a real M503 dump when one is supplied", async () => {
  const ctx = createModelTestContext({ globalArgs: GLOBALS, methodName: "config" });
  withVault(ctx);
  await call(
    "config",
    { logText: "Recv: echo:  M92 X100.00 Y100.00 Z400.00 E500.00\nRecv: echo:  M301 P22.20 I1.08 D114.00" },
    ctx,
  );
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.found, true);
  const settings = d.settings as { stepsPerMm: Record<string, number> };
  assertEquals(settings.stepsPerMm.Z, 400);
  assertEquals((d.notes as string[]).length, 0);
});

Deno.test("snapshot reports dimensions and a darkness verdict for a real frame", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "snapshot",
  });
  withVault(ctx);
  const restore = stubFetch(() =>
    new Response(jpeg(43000).buffer as ArrayBuffer, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })
  );
  try {
    await call("snapshot", {}, ctx);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.ok, true);
  assertEquals(d.width, 640);
  assertEquals(d.height, 480);
  assertEquals(d.dark, false);
  assertEquals((d.sha256 as string).length, 64);
});

Deno.test("snapshot flags a near-black frame", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "snapshot",
  });
  withVault(ctx);
  const restore = stubFetch(() =>
    new Response(jpeg(9000).buffer as ArrayBuffer, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })
  );
  try {
    await call("snapshot", {}, ctx);
  } finally {
    restore();
  }
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.dark, true);
});

Deno.test("webcamConfig reads the running daemon, not the commented config", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "webcamConfig",
  });
  withVault(ctx);
  await call(
    "webcamConfig",
    {
      configText: '#camera="auto"\n#camera_usb_options="-r 640x480 -f 10"\n',
      processArgs:
        "./mjpg_streamer -o output_http.so -w ./www-octopi -i input_uvc.so -r 640x480 -f 10 -d /dev/video0",
    },
    ctx,
  );
  const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(d.daemon, "mjpg_streamer");
  assertEquals(d.resolution, "640x480");
  assertEquals(d.fps, 10);
  assertEquals(d.device, "/dev/video0");
  assertEquals(d.settings, []);
  assertEquals(d.complete, true);
});

