import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  buildSshTransport,
  deliverWorkouts,
  MARKER,
} from "./zwift_coach_delivery.ts";
import { fitnessFixture, goalFixture } from "./zwift_coach_fixtures.ts";
import { generatePlan } from "./zwift_coach_plan.ts";

function test(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, permissions: { read: true, write: true }, fn });
}

function workout(filename: string) {
  return {
    id: filename,
    date: "2026-11-09",
    title: "Test",
    type: "sweetspot",
    filename,
    xml:
      `<?xml version="1.0"?>\n<!-- ${MARKER} plan=p session=s -->\n<workout_file/>`,
    size: 10,
    hash: "abc",
    errors: [],
  };
}

test("local delivery writes into rider/subfolder and is idempotent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const opts = {
      mode: "local" as const,
      planId: "p",
      riderId: "123",
      subfolder: "zwift-coach",
      workoutsDir: dir,
    };
    const first = await deliverWorkouts([workout("a.zwo")], opts);
    assertEquals(first.written.includes("a.zwo"), true);
    const second = await deliverWorkouts([workout("a.zwo")], opts);
    assertEquals(second.skipped.includes("a.zwo"), true);
    const file = await Deno.readTextFile(`${dir}/123/zwift-coach/a.zwo`);
    assertEquals(file.includes(MARKER), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("local delivery refuses to overwrite an unmarked file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/123/zwift-coach`, { recursive: true });
    await Deno.writeTextFile(`${dir}/123/zwift-coach/a.zwo`, "<user-workout/>");
    await assertRejects(
      () =>
        deliverWorkouts([workout("a.zwo")], {
          mode: "local",
          planId: "p",
          riderId: "123",
          subfolder: "zwift-coach",
          workoutsDir: dir,
        }),
      Error,
      "no coach marker",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("sync delivery writes into the sync folder", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await deliverWorkouts([workout("b.zwo")], {
      mode: "sync",
      planId: "p",
      subfolder: "zwift-coach",
      syncDir: dir,
    });
    assertEquals(result.destination, `${dir}/zwift-coach`);
    const file = await Deno.readTextFile(`${dir}/zwift-coach/b.zwo`);
    assertEquals(file.includes(MARKER), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("bundle delivery writes plan, manifest and workouts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const plan = generatePlan(fitnessFixture(), goalFixture());
    const result = await deliverWorkouts([workout("c.zwo")], {
      mode: "bundle",
      planId: plan.id,
      plan,
      subfolder: "zwift-coach",
      bundleDir: dir,
    });
    const base = `${dir}/bundle-${plan.id}`;
    assertEquals(result.destination, base);
    assertEquals(
      (await Deno.readTextFile(`${base}/workouts/c.zwo`)).includes(MARKER),
      true,
    );
    assertEquals(
      (await Deno.readTextFile(`${base}/plan.md`)).includes("# improve plan"),
      true,
    );
    assertEquals(
      (await Deno.readTextFile(`${base}/manifest.json`)).includes("c.zwo"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("ssh transport omits empty user and key so ssh uses its defaults", () => {
  const transport = buildSshTransport({});
  assertEquals(transport, {
    kind: "ssh",
    port: 22,
    strictHostKeyChecking: "accept-new",
  });
  assertEquals(buildSshTransport({ user: "sven" }), {
    kind: "ssh",
    port: 22,
    strictHostKeyChecking: "accept-new",
    user: "sven",
  });
  assertEquals(
    buildSshTransport({ user: "sven", key: "/home/sven/.ssh/id_ed25519" }),
    {
      kind: "ssh",
      port: 22,
      strictHostKeyChecking: "accept-new",
      user: "sven",
      identityFile: "/home/sven/.ssh/id_ed25519",
    },
  );
});

test("prune removes only marked files not in this render", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/123/zwift-coach`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/123/zwift-coach/old.zwo`,
      `<!-- ${MARKER} plan=old session=old --><workout_file/>`,
    );
    await Deno.writeTextFile(
      `${dir}/123/zwift-coach/user.zwo`,
      `<user-workout/>`,
    );
    const result = await deliverWorkouts([workout("new.zwo")], {
      mode: "local",
      planId: "p",
      riderId: "123",
      subfolder: "zwift-coach",
      workoutsDir: dir,
      prune: true,
    });
    assertEquals(result.pruned, ["old.zwo"]);
    assertEquals(
      (await Deno.stat(`${dir}/123/zwift-coach/user.zwo`)).isFile,
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
