/**
 * Minimal CBOR codec (RFC 8949) with the SurrealDB value tags used by the
 * `surrealdb` JS SDK v2 (see node_modules/surrealdb/dist/surrealdb.cjs,
 * TAG_* constants). This is the wire format of the /rpc WebSocket endpoint
 * (subprotocol "cbor").
 *
 * Encoded/decoded JS values use small sentinel classes for Surreal-specific
 * types (record ids, datetimes, uuids, ...) so the rest of the proxy can work
 * with plain strings.
 */

export class SNone {
  constructor() {}
  static INSTANCE = new SNone();
}

export class SRid {
  /** @param {string} table @param {string} id */
  constructor(table, id) {
    this.table = table;
    this.id = id;
  }
  toString() {
    return formatRidString(this.table, this.id);
  }
}

export class SDateTime {
  /** @param {string} iso UTC ISO-8601 */
  constructor(iso) {
    this.iso = iso;
  }
}

export class SUuid {
  constructor(str) {
    this.str = str;
  }
}

export class SDecimal {
  constructor(str) {
    this.str = str;
  }
}

export class SDuration {
  constructor(str) {
    this.str = str;
  }
}

export class STable {
  constructor(name) {
    this.name = name;
  }
}

export class SSet {
  constructor(items) {
    this.items = items;
  }
}

/** Any tag this codec does not interpret (ranges, geometry, files, futures). */
export class STagged {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }
}

export function formatRidString(table, id) {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return `${table}:${id}`;
  return `${table}:⟨${id}⟩`;
}

/** Best-effort parse of a "table:id" string into {table, id}. Returns null if not a rid. */
export function parseRidString(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^([A-Za-z_][A-Za-z0-9_]*):(.+)$/);
  if (!m) return null;
  let id = m[2];
  const braced = id.match(/^⟨(.*)⟩$/s);
  if (braced) id = braced[1];
  return { table: m[1], id };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const TYPE_UINT8 = 24;
const TYPE_UINT16 = 25;
const TYPE_UINT32 = 26;
const TYPE_UINT64 = 27;

function writeHead(bytes, major, arg) {
  const mt = major << 5;
  if (arg < 24) {
    bytes.push(mt | arg);
  } else if (arg < 0x100) {
    bytes.push(mt | TYPE_UINT8, arg);
  } else if (arg < 0x10000) {
    bytes.push(mt | TYPE_UINT16, arg >> 8, arg & 0xff);
  } else if (arg < 0x100000000) {
    bytes.push(
      mt | TYPE_UINT32,
      (arg >>> 24) & 0xff,
      (arg >>> 16) & 0xff,
      (arg >>> 8) & 0xff,
      arg & 0xff
    );
  } else {
    const hi = Math.floor(arg / 0x100000000);
    const lo = arg >>> 0;
    bytes.push(
      mt | TYPE_UINT64,
      (hi >>> 24) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff
    );
  }
}

function encodeInteger(bytes, value) {
  if (typeof value === 'bigint') {
    if (value >= 0n) {
      writeHeadBig(bytes, 0, value);
    } else {
      writeHeadBig(bytes, 1, -value - 1n);
    }
    return;
  }
  if (value >= 0) {
    writeHead(bytes, 0, value);
  } else {
    writeHead(bytes, 1, -value - 1);
  }
}

function writeHeadBig(bytes, major, argBig) {
  const mt = major << 5;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(argBig);
  bytes.push(mt | TYPE_UINT64, ...buf);
}

function encodeString(bytes, str) {
  const utf8 = Buffer.from(str, 'utf8');
  writeHead(bytes, 3, utf8.length);
  for (const b of utf8) bytes.push(b);
}

function encodeBytes(bytes, buf) {
  writeHead(bytes, 2, buf.length);
  for (const b of buf) bytes.push(b);
}

function encodeFloat64(bytes, value) {
  bytes.push(0xfb);
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(value);
  for (const b of buf) bytes.push(b);
}

function encodeTagged(bytes, tag, value) {
  writeHead(bytes, 6, tag);
  encodeValue(bytes, value);
}

function uuidToBytes(str) {
  const hex = String(str).replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Invalid UUID: ${str}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encodeValue(bytes, value) {
  if (value === null) {
    bytes.push(0xf6);
    return;
  }
  if (value === undefined || value instanceof SNone) {
    encodeTagged(bytes, 6, null); // TAG_NONE
    return;
  }
  switch (typeof value) {
    case 'boolean':
      bytes.push(value ? 0xf5 : 0xf4);
      return;
    case 'number':
      if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
        encodeInteger(bytes, value);
      } else {
        encodeFloat64(bytes, value);
      }
      return;
    case 'string':
      encodeString(bytes, value);
      return;
    case 'bigint':
      if (value >= 0n) writeHead(bytes, 0, value);
      else writeHead(bytes, 1, -value - 1n);
      return;
    case 'object':
      break;
    default:
      throw new Error(`Cannot CBOR-encode value of type ${typeof value}`);
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    encodeBytes(bytes, value);
    return;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    const secs = Math.floor(ms / 1000);
    const nsecs = (ms - secs * 1000) * 1e6;
    encodeTagged(bytes, 12, [secs, nsecs]);
    return;
  }
  if (value instanceof SRid) {
    encodeTagged(bytes, 8, [value.table, value.id]); // array form -> SDK yields RecordId
    return;
  }
  if (value instanceof SDateTime) {
    const ms = Date.parse(value.iso);
    if (Number.isNaN(ms)) throw new Error(`Invalid datetime: ${value.iso}`);
    const secs = Math.floor(ms / 1000);
    const nsecs = (ms - secs * 1000) * 1e6;
    encodeTagged(bytes, 12, [secs, nsecs]); // TAG_CUSTOM_DATETIME -> SDK yields DateTime
    return;
  }
  if (value instanceof SUuid) {
    encodeTagged(bytes, 37, uuidToBytes(value.str)); // TAG_SPEC_UUID -> SDK yields Uuid
    return;
  }
  if (value instanceof SDecimal) {
    encodeTagged(bytes, 10, value.str);
    return;
  }
  if (value instanceof SDuration) {
    encodeTagged(bytes, 13, value.str);
    return;
  }
  if (value instanceof STable) {
    encodeTagged(bytes, 7, value.name);
    return;
  }
  if (value instanceof SSet) {
    encodeTagged(bytes, 56, value.items);
    return;
  }
  if (value instanceof STagged) {
    encodeTagged(bytes, value.tag, value.value);
    return;
  }
  if (Array.isArray(value)) {
    writeHead(bytes, 4, value.length);
    for (const item of value) encodeValue(bytes, item);
    return;
  }
  if (value instanceof Set) {
    encodeValue(bytes, [...value]);
    return;
  }
  const keys = Object.keys(value);
  writeHead(bytes, 5, keys.length);
  for (const key of keys) {
    encodeString(bytes, key);
    encodeValue(bytes, value[key]);
  }
}

/** Encode a JS value tree to CBOR bytes. */
export function cborEncode(value) {
  const bytes = [];
  encodeValue(bytes, value);
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

class Reader {
  constructor(buf) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  readHead() {
    const initial = this.u8[this.pos];
    if (initial === undefined) throw new Error('CBOR: unexpected end of input');
    const major = initial >> 5;
    const info = initial & 0x1f;
    this.pos += 1;
    if (major === 7 && info >= 25) {
      // float16/32/64: the additional info is a marker, the float bytes follow
      return { major, value: null, indefinite: false, floatBits: info === 25 ? 16 : info === 26 ? 32 : 64 };
    }
    if (info < 24) return { major, value: info, indefinite: false };
    if (info === 24) return { major, value: this.u8[this.pos++], indefinite: false };
    if (info === 25) {
      const v = this.view.getUint16(this.pos);
      this.pos += 2;
      return { major, value: v, indefinite: false };
    }
    if (info === 26) {
      const v = this.view.getUint32(this.pos);
      this.pos += 4;
      return { major, value: v, indefinite: false };
    }
    if (info === 27) {
      const v = this.view.getBigUint64(this.pos);
      this.pos += 8;
      if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return { major, value: Number(v), indefinite: false };
      return { major, value: v, indefinite: false };
    }
    if (info === 31) return { major, value: null, indefinite: true };
    throw new Error(`CBOR: reserved additional info ${info}`);
  }
  readRaw(length) {
    const out = this.u8.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
  readFloat(bits) {
    let v;
    if (bits === 16) v = decodeHalf(this.view.getUint16(this.pos));
    else if (bits === 32) v = this.view.getFloat32(this.pos);
    else v = this.view.getFloat64(this.pos);
    this.pos += bits / 8;
    return v;
  }
}

function decodeHalf(u16) {
  const exp = (u16 >> 10) & 0x1f;
  const mant = u16 & 0x3ff;
  const sign = u16 >> 15 ? -1 : 1;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp !== 31) return sign * (mant + 1024) * 2 ** (exp - 25);
  if (mant === 0) return sign * Infinity;
  return NaN;
}

function uuidFromBytes(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeTagged(tag, value) {
  switch (tag) {
    case 0: // spec datetime (RFC3339 string)
      return new SDateTime(new Date(value).toISOString());
    case 6:
      return SNone.INSTANCE;
    case 7:
      return new STable(String(value));
    case 8: {
      if (typeof value === 'string') {
        const parsed = parseRidString(value);
        if (!parsed) throw new Error(`CBOR: invalid record id string ${value}`);
        return new SRid(parsed.table, parsed.id);
      }
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
        return new SRid(value[0], value[1]);
      }
      throw new Error('CBOR: unsupported record id payload');
    }
    case 9:
      return new SUuid(String(value));
    case 10:
      return new SDecimal(String(value));
    case 12: {
      const [secs, nsecs] = value;
      const ms = Number(secs) * 1000 + Number(nsecs) / 1e6;
      return new SDateTime(new Date(ms).toISOString());
    }
    case 13:
    case 14:
      return new SDuration(String(value));
    case 37:
      return new SUuid(uuidFromBytes(value));
    case 56:
      return new SSet(value);
    default:
      return new STagged(tag, value);
  }
}

function decodeValue(reader) {
  const { major, value, indefinite, floatBits } = reader.readHead();
  switch (major) {
    case 0:
      return value;
    case 1:
      return typeof value === 'bigint' ? -value - 1n : -value - 1;
    case 2: {
      if (indefinite) {
        const chunks = [];
        for (;;) {
          const head = reader.u8[reader.pos];
          if (head === 0xff) {
            reader.pos += 1;
            break;
          }
          chunks.push(decodeValue(reader));
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return out;
      }
      return reader.readRaw(value);
    }
    case 3: {
      if (indefinite) {
        let str = '';
        for (;;) {
          const head = reader.u8[reader.pos];
          if (head === 0xff) {
            reader.pos += 1;
            break;
          }
          str += decodeValue(reader);
        }
        return str;
      }
      return Buffer.from(reader.readRaw(value)).toString('utf8');
    }
    case 4: {
      const arr = [];
      if (indefinite) {
        for (;;) {
          if (reader.u8[reader.pos] === 0xff) {
            reader.pos += 1;
            break;
          }
          arr.push(decodeValue(reader));
        }
      } else {
        for (let i = 0; i < value; i += 1) arr.push(decodeValue(reader));
      }
      return arr;
    }
    case 5: {
      const obj = {};
      const readPair = () => {
        const key = decodeValue(reader);
        const val = decodeValue(reader);
        obj[typeof key === 'string' ? key : String(key)] = val;
      };
      if (indefinite) {
        for (;;) {
          if (reader.u8[reader.pos] === 0xff) {
            reader.pos += 1;
            break;
          }
          readPair();
        }
      } else {
        for (let i = 0; i < value; i += 1) readPair();
      }
      return obj;
    }
    case 6:
      return decodeTagged(value, decodeValue(reader));
    case 7:
      if (indefinite) throw new Error('CBOR: unsupported indefinite simple value');
      if (value === 20) return false;
      if (value === 21) return true;
      if (value === 22) return null;
      if (value === 23) return undefined;
      if (floatBits) return reader.readFloat(floatBits);
      throw new Error(`CBOR: unsupported simple value ${value}`);
    default:
      throw new Error(`CBOR: unsupported major type ${major}`);
  }
}

/** Decode CBOR bytes to a JS value tree (with sentinels for Surreal types). */
export function cborDecode(data) {
  const reader = new Reader(data instanceof Uint8Array ? data : new Uint8Array(data));
  return decodeValue(reader);
}
