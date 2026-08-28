/**
 * Minimal JSON Schema subset validator.
 *
 * Why not ajv (already in the SDK's dependency tree)? Two reasons that matter on a
 * phone: the add-on contract (spec §5.2) says tool inputs are plain JSON Schema, and
 * we want add-on authors to declare schemas without pulling a validator into their own
 * dependency list. This covers exactly the keywords the spec's schemas use.
 *
 * Supported: type, properties, required, additionalProperties (boolean), items, enum,
 * minimum, maximum, minLength, maxLength, pattern, default.
 * Anything else is ignored rather than rejected, so an add-on may carry richer schema
 * annotations for the model without this validator choking on them.
 */

const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null
};

/**
 * @returns {string[]} human-readable error strings; empty means valid.
 */
export function validate(schema, value, path = '') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  const at = path || 'value';

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPES[t]?.(value))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${describe(value)}`);
      return errors; // further checks would be noise
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${at}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${at}: must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: must match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
  }

  if (TYPES.object(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required property '${key}'`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(sub, value[key], path ? `${path}.${key}` : key));
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) errors.push(`${at}: unknown property '${key}'`);
      }
    }
  }

  return errors;
}

/** Returns a copy of `value` with schema defaults filled in for absent properties. */
export function applyDefaults(schema, value) {
  if (!schema || typeof schema !== 'object') return value;
  if (schema.type === 'object' || schema.properties) {
    const out = { ...(TYPES.object(value) ? value : {}) };
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (!(key in out)) {
        // Seed from the declared default, then recurse: an object default like
        // `watcher: { default: {} }` must still receive its own properties' defaults,
        // or `{}` would be taken literally and pollSeconds would arrive undefined.
        // Only seeded when a default is declared, so a property with no default stays
        // absent and `required` keeps meaning what it says.
        if (sub.default !== undefined) out[key] = applyDefaults(sub, structuredClone(sub.default));
      } else {
        out[key] = applyDefaults(sub, out[key]);
      }
    }
    return out;
  }
  return value === undefined && schema.default !== undefined ? structuredClone(schema.default) : value;
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}
