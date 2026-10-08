/**
 * Deep-converts a value into something JSON.stringify accepts for jsonb
 * columns: bigint -> decimal string (santim stay exact), Date -> ISO string
 * (invalid dates -> null, like Date#toJSON). Arrays and objects are copied;
 * `undefined` object properties are dropped. Circular references throw.
 */
export function toJsonSafe(value: unknown): unknown {
  return convert(value, new WeakSet<object>());
}

function convert(value: unknown, seen: WeakSet<object>): unknown {
  switch (typeof value) {
    case 'bigint':
      return value.toString();
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'string':
    case 'boolean':
      return value;
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError('toJsonSafe: circular reference');
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // JSON turns holes and unrepresentable items into null inside arrays.
      return object.map((item: unknown) => {
        const converted = convert(item, seen);
        return converted === undefined ? null : converted;
      });
    }
    if (object instanceof Map) {
      return convert(Object.fromEntries(object), seen);
    }
    if (object instanceof Set) {
      return convert([...object], seen);
    }
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return convert((toJSON as () => unknown).call(object), seen);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const converted = convert(item, seen);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  } finally {
    seen.delete(object);
  }
}
