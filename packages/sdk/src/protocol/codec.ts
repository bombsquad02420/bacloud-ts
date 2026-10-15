/**
 * Minimal mirror of ballistica's `efro.dataclassio` JSON codec.
 *
 * Python dataclasses on the wire use short storage keys (`IOAttrs('c')`);
 * here each type declares a {@link Schema} mapping friendly TypeScript
 * field names to those keys. Fields equal to `undefined` are omitted on
 * encode (the `store_default=False` behaviour) and missing keys decode
 * to `undefined`.
 *
 * Multitypes (`IOMultiType`) store their type id under `_t`; the
 * default member of a hierarchy is written without one.
 */

export type FieldKind =
  | "value"
  | "bytes"
  | { readonly object: Schema }
  | { readonly list: FieldKind }
  | { readonly record: FieldKind };

export interface FieldSpec {
  readonly key: string;
  readonly kind?: FieldKind;
}

export type Schema = Readonly<Record<string, FieldSpec | string>>;

/** Storage key for a multitype's type id. */
export const TYPE_ID_KEY = "_t";

type Json = unknown;
type JsonObject = Record<string, Json>;

function spec(field: FieldSpec | string): FieldSpec {
  return typeof field === "string" ? { key: field } : field;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeValue(kind: FieldKind, value: unknown): Json {
  if (kind === "value") return value;
  if (kind === "bytes") return bytesToBase64(value as Uint8Array);
  if ("object" in kind) return encode(kind.object, value as object);
  if ("list" in kind) return (value as unknown[]).map((v) => encodeValue(kind.list, v));
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = encodeValue(kind.record, v);
  }
  return out;
}

function decodeValue(kind: FieldKind, value: Json, path: string): unknown {
  if (kind === "value") return value;
  if (kind === "bytes") {
    if (typeof value !== "string") throw new TypeError(`${path}: expected base64 string`);
    return base64ToBytes(value);
  }
  if ("object" in kind) return decode(kind.object, value, path);
  if ("list" in kind) {
    if (!Array.isArray(value)) throw new TypeError(`${path}: expected list`);
    return value.map((v, i) => decodeValue(kind.list, v, `${path}[${i}]`));
  }
  if (!isObject(value)) throw new TypeError(`${path}: expected object`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = decodeValue(kind.record, v, `${path}.${k}`);
  }
  return out;
}

/** Convert a friendly-named object into its wire form. */
export function encode(schema: Schema, value: object): JsonObject {
  const source = value as Record<string, unknown>;
  const out: JsonObject = {};
  for (const [name, field] of Object.entries(schema)) {
    const v = source[name];
    if (v === undefined) continue;
    const { key, kind = "value" } = spec(field);
    out[key] = encodeValue(kind, v);
  }
  return out;
}

/** Convert a wire-form object into its friendly-named form. */
export function decode<T>(schema: Schema, value: Json, path = "$"): T {
  if (!isObject(value)) throw new TypeError(`${path}: expected object`);
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    const { key, kind = "value" } = spec(field);
    if (!(key in value) || value[key] === null) continue;
    out[name] = decodeValue(kind, value[key], `${path}.${key}`);
  }
  return out as T;
}

/**
 * Encode/decode for an `IOMultiType` hierarchy whose members are
 * tagged unions keyed by `type`.
 */
export function multitype<Id extends string, T extends { type: Id }>(
  variants: Readonly<Record<Id, Schema>>,
  defaultId?: Id,
) {
  return {
    encode(value: T): JsonObject {
      const out = encode(variants[value.type], value);
      if (value.type !== defaultId) out[TYPE_ID_KEY] = value.type;
      return out;
    },
    decode(value: Json): T {
      if (!isObject(value)) throw new TypeError("$: expected object");
      const id = (value[TYPE_ID_KEY] ?? defaultId) as Id | undefined;
      if (id === undefined || !(id in variants)) {
        throw new TypeError(`Unrecognized type-id ${String(id)}.`);
      }
      return { ...decode<object>(variants[id], value), type: id } as T;
    },
  };
}
