import React from "react";
import type { JsonSchema, JsonSchemaProperty } from "./api";

// Render a form for a JSON-schema-shaped argument set. Produces a Record<string, unknown>
// of input values (only includes fields the user touched or that have defaults).
export function SchemaForm({
  schema,
  values,
  onChange,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  if (Object.keys(props).length === 0) {
    return <div style={{ color: "var(--muted)" }}>This method takes no inputs.</div>;
  }
  return (
    <div>
      {Object.entries(props).map(([key, prop]) => (
        <Field
          key={key}
          name={key}
          prop={prop}
          required={required.has(key)}
          value={values[key]}
          onChange={(v) => {
            const next = { ...values };
            if (v === undefined) delete next[key];
            else next[key] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

function Field({
  name,
  prop,
  required,
  value,
  onChange,
}: {
  name: string;
  prop: JsonSchemaProperty;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const type = prop.type || (prop.enum ? "string" : guessType(prop));
  const hasDefault = "default" in prop;

  // Auto-fill default once.
  React.useEffect(() => {
    if (hasDefault && value === undefined) onChange(prop.default);
  }, []);

  const setStr = (s: string) => {
    if (s === "") onChange(undefined);
    else onChange(s);
  };

  if (prop.enum) {
    return (
      <div className="form-field">
        <label>{name}{required && <span className="req"> *</span>}</label>
        <select value={(value as string) ?? ""} onChange={(e) => setStr(e.target.value)}>
          <option value="">—</option>
          {prop.enum.map((opt) => <option key={String(opt)} value={String(opt)}>{String(opt)}</option>)}
        </select>
        {prop.description && <div className="hint">{prop.description}</div>}
      </div>
    );
  }

  if (type === "boolean") {
    return (
      <div className="form-field">
        <label>{name}{required && <span className="req"> *</span>}</label>
        <select
          value={value === undefined ? "" : value ? "true" : "false"}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}
        >
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        {prop.description && <div className="hint">{prop.description}</div>}
      </div>
    );
  }

  if (type === "number" || type === "integer") {
    return (
      <div className="form-field">
        <label>{name}{required && <span className="req"> *</span>}</label>
        <input
          type="number"
          value={value === undefined ? "" : String(value)}
          min={prop.minimum}
          max={prop.maximum}
          step={type === "integer" ? 1 : "any"}
          onChange={(e) => {
            const s = e.target.value;
            if (s === "") onChange(undefined);
            else onChange(type === "integer" ? parseInt(s, 10) : parseFloat(s));
          }}
        />
        {prop.description && <div className="hint">{prop.description}</div>}
      </div>
    );
  }

  if (type === "array" || type === "object") {
    // JSON textarea
    return (
      <div className="form-field">
        <label>{name}{required && <span className="req"> *</span>} <span style={{ color: "var(--muted)" }}>({type} as JSON)</span></label>
        <textarea
          value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2)}
          onChange={(e) => {
            const s = e.target.value;
            // Allow raw strings prefixed with json= for the swamp CLI's complex type syntax.
            if (s.trim().startsWith("json=")) onChange(s);
            else {
              // Try to parse; if it parses, store the parsed value; otherwise store the raw string.
              try {
                const parsed = JSON.parse(s);
                onChange(parsed);
              } catch {
                onChange(s);
              }
            }
          }}
        />
        {prop.description && <div className="hint">{prop.description}</div>}
      </div>
    );
  }

  // string (default)
  return (
    <div className="form-field">
      <label>{name}{required && <span className="req"> *</span>}</label>
      <input
        type={prop.format === "uri" ? "url" : "text"}
        value={(value as string) ?? ""}
        onChange={(e) => setStr(e.target.value)}
        placeholder={prop.description || ""}
      />
      {prop.description && <div className="hint">{prop.description}</div>}
    </div>
  );
}

function guessType(prop: JsonSchemaProperty): string {
  if (prop.format === "uri" || prop.format === "date-time") return "string";
  if (prop.items) return "array";
  return "string";
}