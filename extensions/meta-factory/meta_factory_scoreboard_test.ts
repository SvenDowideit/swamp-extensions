/**
 * Unit tests for the meta-factory scoreboard report and its renderers.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildScoreboard,
  type ScoreboardScore,
  sortScores,
} from "./meta_factory_scoreboard.ts";
import { renderScoreboard } from "./meta_factory_scoreboard.ts";

function score(over: Partial<ScoreboardScore>): ScoreboardScore {
  return {
    name: "@me/tool",
    manifest: "extensions/models/tool/manifest.yaml",
    score: 80,
    grade: "B",
    earned: 80,
    earnedMax: 100,
    checks: [],
    nextActions: [],
    ...over,
  };
}

Deno.test("buildScoreboard marks perfect scores with no reasons", () => {
  const rows = buildScoreboard([
    score({ name: "@me/perfect", score: 100, grade: "A" }),
    score({
      name: "@me/good",
      score: 80,
      nextActions: ["sections: missing `## Install`"],
    }),
  ]);
  const perfect = rows.find((r) => r.name === "@me/perfect")!;
  const good = rows.find((r) => r.name === "@me/good")!;
  assertEquals(perfect.reasons, []);
  assertEquals(good.reasons, ["sections: missing `## Install`"]);
});

Deno.test("buildScoreboard falls back to non-passing checks", () => {
  const rows = buildScoreboard([
    score({
      name: "@me/old",
      score: 70,
      nextActions: undefined,
      checks: [
        {
          id: "install",
          label: "Install",
          earned: 0,
          max: 13,
          status: "fail",
          note: "no pull",
        },
        { id: "manual", label: "Manual", earned: 8, max: 8, status: "pass" },
      ],
    }),
  ]);
  assertEquals(rows[0].reasons, ["install: no pull"]);
});

Deno.test("sortScores orders by ascending score then name", () => {
  const sorted = sortScores([
    score({ name: "@me/b", score: 90 }),
    score({ name: "@me/a", score: 90 }),
    score({ name: "@me/low", score: 10 }),
  ]);
  assertEquals(sorted.map((s) => s.name), ["@me/low", "@me/a", "@me/b"]);
});

Deno.test("renderScoreboard produces a table with a reason column", () => {
  const rows = buildScoreboard([
    score({ name: "@me/perfect", score: 100, grade: "A" }),
    score({
      name: "@me/bad",
      score: 55,
      grade: "D",
      nextActions: ["install: no `swamp extension pull` command found"],
    }),
  ]);
  const md = renderScoreboard(rows);
  assertStringIncludes(md, "| Extension | Score | Grade | Reason not 100 |");
  assertStringIncludes(md, "| @me/bad | 55/100 | D | 1 issue(s) |");
  assertStringIncludes(md, "| @me/perfect | 100/100 | A | — |");
  assertStringIncludes(md, "## Reasons");
  assertStringIncludes(md, "install: no `swamp extension pull` command found");
});

Deno.test("renderScoreboard summarises count, average, and perfect", () => {
  const md = renderScoreboard(buildScoreboard([
    score({ name: "@me/a", score: 100, grade: "A" }),
    score({ name: "@me/b", score: 50, grade: "D", nextActions: ["x: y"] }),
  ]));
  assertStringIncludes(md, "**2** extension(s) · average **75/100**");
  assertStringIncludes(md, "**1** perfect · **1** with reasons");
});

Deno.test("renderScoreboard escapes pipes in names and notes", () => {
  const md = renderScoreboard(buildScoreboard([
    score({
      name: "@me/a|b",
      score: 50,
      nextActions: ["note with | pipe"],
    }),
  ]));
  // The rendered table row must not contain a raw unescaped pipe in the cell.
  assertStringIncludes(md, "@me/a\\|b");
});
