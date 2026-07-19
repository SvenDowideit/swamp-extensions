import React from "react";
import { api, type JsonSchema } from "./api";
import { SchemaForm } from "./SchemaForm";

type TriggerKind =
  | { kind: "workflow"; name: string; schema?: JsonSchema }
  | { kind: "method"; model: string; method: string; schema: JsonSchema };

export function TriggerDialog({
  trigger,
  onClose,
  onDone,
}: {
  trigger: TriggerKind;
  onClose: () => void;
  onDone: (msg: string, isError?: boolean) => void;
}) {
  const [inputs, setInputs] = React.useState<Record<string, unknown>>({});
  const [running, setRunning] = React.useState(false);

  const schema = trigger.kind === "workflow" ? trigger.schema : trigger.schema;
  const title = trigger.kind === "workflow"
    ? `Run workflow: ${trigger.name}`
    : `Run ${trigger.method} on ${trigger.model}`;

  const run = async () => {
    setRunning(true);
    try {
      let result: unknown;
      if (trigger.kind === "workflow") {
        result = await api.runWorkflow(trigger.name, inputs);
      } else {
        result = await api.runMethod(trigger.model, trigger.method, inputs);
      }
      onDone("Run completed.", false);
      // eslint-disable-next-line no-console
      console.log("run result", result);
      onClose();
    } catch (err) {
      onDone(String(err), true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {schema ? (
          <SchemaForm schema={schema} values={inputs} onChange={setInputs} />
        ) : (
          <div style={{ color: "var(--muted)" }}>Loading inputs… (no workflow inputs declared)</div>
        )}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={run} disabled={running}>
            {running ? "Running…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}