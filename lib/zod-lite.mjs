// A minimal stand-in for the subset of zod's builder API this server uses, so the
// tool definitions in server.js work unchanged when zod isn't installed.
// Each builder records JSON Schema directly — there is no runtime type coercion
// beyond applying defaults and checking required keys (see mcp-lite.mjs).

function make(json) {
  return {
    _json: json,
    _optional: false,
    _hasDefault: false,
    _default: undefined,
    describe(text) {
      this._json.description = text;
      return this;
    },
    optional() {
      this._optional = true;
      return this;
    },
    default(value) {
      this._hasDefault = true;
      this._default = value;
      this._json.default = value;
      return this;
    },
    int() {
      this._json.type = "integer";
      return this;
    },
    min(n) {
      if (this._json.type === "string") this._json.minLength = n;
      else if (this._json.type === "array") this._json.minItems = n;
      else this._json.minimum = n;
      return this;
    },
    max(n) {
      if (this._json.type === "string") this._json.maxLength = n;
      else if (this._json.type === "array") this._json.maxItems = n;
      else this._json.maximum = n;
      return this;
    },
  };
}

export const z = {
  string: () => make({ type: "string" }),
  number: () => make({ type: "number" }),
  boolean: () => make({ type: "boolean" }),
  array: (inner) => make({ type: "array", items: { ...inner._json } }),
  enum: (values) => make({ type: "string", enum: [...values] }),
};

// Converts a raw shape ({ key: builder }) into a JSON Schema object.
export function shapeToJsonSchema(shape) {
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(shape ?? {})) {
    properties[key] = { ...field._json };
    if (!field._optional && !field._hasDefault) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// Applies declared defaults and reports missing required keys.
export function applyShape(shape, args) {
  const out = { ...(args ?? {}) };
  const missing = [];
  for (const [key, field] of Object.entries(shape ?? {})) {
    if (out[key] === undefined) {
      if (field._hasDefault) out[key] = field._default;
      else if (!field._optional) missing.push(key);
    }
  }
  if (missing.length) throw new Error(`Missing required argument(s): ${missing.join(", ")}`);
  return out;
}
