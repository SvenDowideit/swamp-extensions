/**
 * Tests for the pure Modelfile rendering and fit maths in
 * `ollama_models_shared.ts` — the "customise it to my systems" logic.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  deriveFitParameters,
  mergeParameters,
  type Parameter,
  parseModelfile,
  quoteModelfileValue,
  renderModelfile,
  tokensPerSecond,
} from "./ollama_models_shared.ts";

Deno.test("deriveFitParameters keeps full GPU offload and context when it fits", () => {
  const fit = deriveFitParameters(4683071232, 32768, {
    vramMiB: 24564,
    ramMiB: 128000,
  });
  assertEquals(fit.placement, "gpu");
  assertEquals(fit.numGpu, 999);
  assertEquals(fit.numCtx, 32768);
  assertEquals(fit.kvCacheMiB, 2048);
});

Deno.test("deriveFitParameters shrinks the context to fit VRAM", () => {
  const fit = deriveFitParameters(23000 * 1048576, 32768, {
    vramMiB: 24564,
    ramMiB: 128000,
  });
  assertEquals(fit.placement, "gpu");
  assertEquals(fit.numGpu, 999);
  assertEquals(fit.numCtx, 16384);
});

Deno.test("deriveFitParameters falls back to CPU, then too-large", () => {
  const cpu = deriveFitParameters(8000 * 1048576, 8192, {
    vramMiB: 0,
    ramMiB: 128000,
  });
  assertEquals(cpu.placement, "cpu");
  assertEquals(cpu.numGpu, 0);
  const huge = deriveFitParameters(200000 * 1048576, 8192, {
    vramMiB: 24564,
    ramMiB: 64000,
  });
  assertEquals(huge.placement, "too-large");
});

Deno.test("mergeParameters lets user values win and keeps order", () => {
  const derived: Parameter[] = [
    { key: "num_ctx", value: "8192" },
    { key: "num_gpu", value: "999" },
  ];
  const user: Parameter[] = [{ key: "num_ctx", value: "4096" }, {
    key: "temperature",
    value: "0.2",
  }];
  assertEquals(mergeParameters(derived, user), [
    { key: "num_ctx", value: "4096" },
    { key: "num_gpu", value: "999" },
    { key: "temperature", value: "0.2" },
  ]);
});

Deno.test("quoteModelfileValue leaves plain values and wraps multiline/quoted", () => {
  assertEquals(quoteModelfileValue("0.2"), "0.2");
  assertEquals(quoteModelfileValue("a\nb"), '"""\na\nb\n"""');
  assertEquals(quoteModelfileValue('say "hi"'), '"""\nsay "hi"\n"""');
});

Deno.test("renderModelfile emits FROM, parameters, template, system, license", () => {
  const text = renderModelfile({
    from: "/models/coder-Q4_K_M.gguf",
    adapter: "/models/lora.gguf",
    template: "{{ .Prompt }}",
    system: "You are a helpful coding assistant.",
    license: "MIT",
    parameters: [
      { key: "num_ctx", value: "8192" },
      { key: "temperature", value: "0.2" },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assertStringIncludes(text, "FROM /models/coder-Q4_K_M.gguf");
  assertStringIncludes(text, "ADAPTER /models/lora.gguf");
  assertStringIncludes(text, "PARAMETER num_ctx 8192");
  assertStringIncludes(text, "PARAMETER temperature 0.2");
  assertStringIncludes(text, "TEMPLATE {{ .Prompt }}");
  assertStringIncludes(text, "SYSTEM You are a helpful coding assistant.");
  assertStringIncludes(text, "MESSAGE user hi");
  assertStringIncludes(text, "LICENSE MIT");
  assertEquals(text.endsWith("\n"), true);
});

Deno.test("parseModelfile reads back FROM, parameters, template, system", () => {
  const parsed = parseModelfile(
    'FROM x.gguf\nPARAMETER num_ctx 4096\nTEMPLATE """\n{{ .Prompt }}\n"""\nSYSTEM hi\n',
  );
  assertEquals(parsed.from, "x.gguf");
  assertEquals(parsed.template, "{{ .Prompt }}");
  assertEquals(parsed.system, "hi");
  assertEquals(parsed.parameters, [{ key: "num_ctx", value: "4096" }]);
});

Deno.test("tokensPerSecond computes from eval_count/eval_duration", () => {
  assertEquals(tokensPerSecond(10, 1_000_000_000), 10);
  assertEquals(tokensPerSecond(50, 2_000_000_000), 25);
  assertEquals(tokensPerSecond(0, 0), 0);
});
