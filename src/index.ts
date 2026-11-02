/**
 * Photo and document metadata reader and stripper.
 * Works on the file's bytes in memory, in a browser or in Node. Nothing is uploaded and nothing is re-encoded.
 *
 * JPEG: drops EXIF, XMP, IPTC, comments, Multi-Picture Format and any other APP2 block that is not an ICC profile,
 * and anything after the end-of-image marker. A minimal EXIF orientation is written back so the photo stays upright.
 * PNG: drops eXIf, text, tIME and content-credentials (caBX) chunks.
 * WebP: drops EXIF and XMP chunks and clears the matching VP8X flags.
 * TIFF: rebuilds the container with the image strips copied as-is and only the tags a decoder needs, plus orientation and ICC.
 * PDF: blanks uncompressed Info strings and XMP metadata in place. Encrypted files, object streams and compressed
 * metadata are left untouched and reported as something that cannot be cleaned safely.
 * HEIC: zeroes Exif and XMP item bytes in place when the item-location box is a simple file offset. Other layouts
 * are reported as unsupported rather than rewritten.
 */

export type MetaKind =
  | "location"
  | "camera"
  | "date"
  | "software"
  | "author"
  | "serial"
  | "xmp"
  | "iptc"
  | "comment"
  | "text"
  | "credentials"
  | "document";
export interface MetaField {
  kind: MetaKind;
  tag: string;
  value: string;
}
export type PhotoFormat = "jpeg" | "png" | "webp" | "tiff" | "pdf" | "heic";
export interface PhotoMeta {
  format: PhotoFormat;
  fields: MetaField[];
  gps: { lat: number; lon: number } | null;
  orientation: number;
  /** False when a clean copy would have to rewrite bytes that cannot be moved safely. */
  canStrip: boolean;
  /** Why a clean copy is not offered (see LIMITS for an English sentence). */
  limit?: LimitCode;
}

/** Why a file can't be read or cleaned. Each code has an English sentence in LIMITS for display. */
export type LimitCode =
  "damaged" | "format" | "heic_layout" | "pdf_encrypted" | "pdf_compressed" | "pdf_structure" | "tiff_unsafe";

export const LIMITS: Readonly<Record<LimitCode, string>> = {
  damaged: "That file looks damaged, so it wasn't changed.",
  format: "This file isn't a JPEG, PNG, WebP, TIFF, PDF or HEIC.",
  heic_layout:
    "This HEIC stores metadata in a layout that can't be removed safely. Export it as JPEG, then clean that copy.",
  pdf_encrypted: "This PDF is encrypted, so its metadata can't be removed.",
  pdf_compressed:
    "This PDF stores its metadata in a compressed section that can't be rewritten safely. Print it to a new PDF, then clean that copy.",
  pdf_structure: "This PDF's structure can't be cleaned safely. Print it to a new PDF, then clean that copy.",
  tiff_unsafe: "This TIFF can't be rewritten without changing the picture.",
};

/** Thrown when a file can't be read or a clean copy can't be made safely. `code` says why; `message` is English. */
export class UnsupportedImage extends Error {
  readonly code: LimitCode;
  constructor(code: LimitCode) {
    super(LIMITS[code]);
    this.name = "UnsupportedImage";
    this.code = code;
  }
}

const DAMAGED: LimitCode = "damaged";
const FORMAT: LimitCode = "format";
const HEIC_UNSAFE: LimitCode = "heic_layout";
const PDF_ENCRYPT: LimitCode = "pdf_encrypted";
const PDF_UNSAFE: LimitCode = "pdf_compressed";
const PDF_STRUCT: LimitCode = "pdf_structure";
const TIFF_UNSAFE: LimitCode = "tiff_unsafe";

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const startsWith = (b: Uint8Array, s: string) => {
  if (b.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
};
const clean = (s: string) => s.replace(/\0+$/, "").replace(/\0/g, "").trim();

function indexOfBytes(b: Uint8Array, needle: string, from = 0, end = b.length): number {
  const n = needle.length;
  const last = Math.min(end, b.length) - n;
  for (let i = Math.max(0, from); i <= last; i++) {
    let ok = true;
    for (let j = 0; j < n; j++)
      if (b[i + j] !== needle.charCodeAt(j)) {
        ok = false;
        break;
      }
    if (ok) return i;
  }
  return -1;
}

type Body = Omit<PhotoMeta, "format">;
const body = (): Body => ({ fields: [], gps: null, orientation: 1, canStrip: true });

function noteGps(meta: Body, gps: PhotoMeta["gps"]) {
  if (!gps || meta.gps) return;
  if (!Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) return;
  if (Math.abs(gps.lat) > 90 || Math.abs(gps.lon) > 180) return;
  if (gps.lat === 0 && gps.lon === 0) return;
  meta.gps = gps;
  if (!meta.fields.some((f) => f.kind === "location"))
    meta.fields.unshift({ kind: "location", tag: "GPS", value: `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` });
}

function mergeExif(meta: Body, bytes: Uint8Array) {
  const ex = readExif(bytes);
  noteGps(meta, ex.gps);
  if (meta.orientation === 1 && ex.orientation !== 1) meta.orientation = ex.orientation;
  for (const f of ex.fields) {
    if (f.kind === "location") continue;
    if (!meta.fields.some((x) => x.kind === f.kind && x.tag === f.tag && x.value === f.value)) meta.fields.push(f);
  }
}

// TIFF / EXIF
interface Tiff {
  view: DataView;
  le: boolean;
  base: number;
  end: number;
  bytes: Uint8Array;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
/** Tags a decoder needs. Privacy tags (GPS, EXIF pointer, artist, make, dates, maker notes) are not in this set. */
const TIFF_KEEP = new Set([
  256, 257, 258, 259, 262, 274, 277, 278, 282, 283, 284, 296, 317, 320, 338, 339, 529, 530, 531, 532, 34675,
]);
const TIFF_SAFE_COMPRESSION = new Set([1, 2, 3, 4, 5, 6, 7, 8, 32773]);

function readValue(t: Tiff, entry: number): string | number | number[] | null {
  const { view, le, base } = t;
  const type = view.getUint16(entry + 2, le);
  const count = view.getUint32(entry + 4, le);
  const size = (TYPE_SIZE[type] ?? 1) * count;
  if (size > 65_536) return null;
  const at = size <= 4 ? entry + 8 : base + view.getUint32(entry + 8, le);
  if (at < 0 || at + size > t.end) return null;
  if (type === 2) return clean(latin1(new Uint8Array(view.buffer, view.byteOffset + at, size)));
  const out: number[] = [];
  for (let i = 0; i < Math.min(count, 16); i++) {
    if (type === 3) out.push(view.getUint16(at + i * 2, le));
    else if (type === 4 || type === 9) out.push(view.getUint32(at + i * 4, le));
    else if (type === 5 || type === 10) {
      const d = view.getUint32(at + i * 8 + 4, le);
      out.push(d ? view.getUint32(at + i * 8, le) / d : 0);
    } else out.push(view.getUint8(at + i));
  }
  return out.length === 1 ? out[0] : out;
}

function readIfd(t: Tiff, offset: number): Map<number, string | number | number[] | null> {
  const tags = new Map<number, string | number | number[] | null>();
  const at = t.base + offset;
  if (at + 2 > t.end || offset <= 0) return tags;
  const n = t.view.getUint16(at, t.le);
  for (let i = 0; i < n && i < 512; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > t.end) break;
    tags.set(t.view.getUint16(e, t.le), readValue(t, e));
  }
  return tags;
}

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  at: number;
}

function readRawIfd(t: Tiff, offset: number): { entries: RawEntry[]; next: number } {
  const at = t.base + offset;
  if (at + 2 > t.end || offset <= 0) return { entries: [], next: 0 };
  const n = t.view.getUint16(at, t.le);
  if (n > 4096) throw new UnsupportedImage(DAMAGED);
  const entries: RawEntry[] = [];
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > t.end) throw new UnsupportedImage(DAMAGED);
    entries.push({
      tag: t.view.getUint16(e, t.le),
      type: t.view.getUint16(e + 2, t.le),
      count: t.view.getUint32(e + 4, t.le),
      at: e,
    });
  }
  const nextAt = at + 2 + n * 12;
  const next = nextAt + 4 <= t.end ? t.view.getUint32(nextAt, t.le) : 0;
  return { entries, next };
}

function entryNumbers(t: Tiff, e: RawEntry): number[] {
  const unit = TYPE_SIZE[e.type];
  if (unit !== 1 && unit !== 2 && unit !== 4) throw new UnsupportedImage(DAMAGED);
  const size = unit * e.count;
  if (size <= 0 || size > t.end) throw new UnsupportedImage(DAMAGED);
  const at = size <= 4 ? e.at + 8 : t.base + t.view.getUint32(e.at + 8, t.le);
  if (at < 0 || at + size > t.end) throw new UnsupportedImage(DAMAGED);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    if (e.type === 3) out.push(t.view.getUint16(at + i * 2, t.le));
    else if (e.type === 4) out.push(t.view.getUint32(at + i * 4, t.le));
    else out.push(t.view.getUint8(at + i));
  }
  return out;
}

const dms = (v: unknown, ref: unknown): number | null => {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [d, m, s] = v as unknown[];
  if (typeof d !== "number" || typeof m !== "number" || typeof s !== "number") return null;
  const deg = d + m / 60 + s / 3600;
  return ref === "S" || ref === "W" ? -deg : deg;
};

/** EXIF block (starting at the TIFF header) → fields. */
function readExif(bytes: Uint8Array): Omit<PhotoMeta, "format" | "canStrip"> {
  if (bytes.byteLength < 8) return { fields: [], gps: null, orientation: 1 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return { fields: [], gps: null, orientation: 1 };
  const t: Tiff = { view, le: order === 0x4949, base: 0, end: bytes.byteLength, bytes };
  if (view.getUint32(4, t.le) <= 0 || view.getUint32(4, t.le) >= bytes.byteLength)
    return { fields: [], gps: null, orientation: 1 };
  const ifd0 = readIfd(t, view.getUint32(4, t.le));
  const exif =
    typeof ifd0.get(0x8769) === "number"
      ? readIfd(t, ifd0.get(0x8769) as number)
      : new Map<number, string | number | number[] | null>();
  const gpsIfd =
    typeof ifd0.get(0x8825) === "number"
      ? readIfd(t, ifd0.get(0x8825) as number)
      : new Map<number, string | number | number[] | null>();
  const fields: MetaField[] = [];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const push = (kind: MetaKind, tag: string, v: unknown) => {
    const s = str(v);
    if (s) fields.push({ kind, tag, value: s });
  };
  const camera = [str(ifd0.get(0x010f)), str(ifd0.get(0x0110))].filter(Boolean).join(" ");
  if (camera) fields.push({ kind: "camera", tag: "Camera", value: camera });
  push("camera", "Lens", exif.get(0xa434));
  push("date", "Taken", exif.get(0x9003) ?? ifd0.get(0x0132));
  push("software", "Software", ifd0.get(0x0131));
  push("author", "Artist", ifd0.get(0x013b));
  push("author", "Copyright", ifd0.get(0x8298));
  push("author", "Owner", exif.get(0xa430));
  push("serial", "Serial number", exif.get(0xa431));
  let gps: PhotoMeta["gps"] = null;
  const lat = dms(gpsIfd.get(2), gpsIfd.get(1));
  const lon = dms(gpsIfd.get(4), gpsIfd.get(3));
  if (lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
    gps = { lat, lon };
    fields.unshift({ kind: "location", tag: "GPS", value: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
  }
  const o = ifd0.get(0x0112);
  return { fields, gps, orientation: typeof o === "number" && o >= 1 && o <= 8 ? o : 1 };
}

function openTiff(b: Uint8Array): Tiff {
  if (b.byteLength < 8) throw new UnsupportedImage(DAMAGED);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) throw new UnsupportedImage(DAMAGED);
  const le = order === 0x4949;
  if (view.getUint16(2, le) !== 42) throw new UnsupportedImage(TIFF_UNSAFE);
  return { view, le, base: 0, end: b.byteLength, bytes: b };
}

function compressionOf(t: Tiff, entries: RawEntry[]): number {
  const e = entries.find((x) => x.tag === 259);
  if (!e) return 1;
  return entryNumbers(t, e)[0] ?? 1;
}

function imageStrips(t: Tiff, entries: RawEntry[], compression: number): Uint8Array[] {
  const off = entries.find((e) => e.tag === 273) ?? entries.find((e) => e.tag === 324);
  const cnt = entries.find((e) => e.tag === (off?.tag === 324 ? 325 : 279));
  if (!off || !cnt) throw new UnsupportedImage(DAMAGED);
  const offsets = entryNumbers(t, off);
  const counts = entryNumbers(t, cnt);
  if (offsets.length !== counts.length || offsets.length === 0 || offsets.length > 10_000)
    throw new UnsupportedImage(DAMAGED);
  return offsets.map((at, i) => {
    const n = counts[i];
    if (at < 0 || n < 0 || at + n > t.end) throw new UnsupportedImage(DAMAGED);
    const raw = new Uint8Array(t.view.buffer, t.view.byteOffset + at, n);
    if ((compression === 6 || compression === 7) && isJpeg(raw))
      return stripJpeg(raw.slice(), readJpeg(raw).orientation);
    return raw.slice();
  });
}

function valueBytes(t: Tiff, e: RawEntry): Uint8Array {
  const size = (TYPE_SIZE[e.type] ?? 0) * e.count;
  if (!TYPE_SIZE[e.type] || size <= 0 || size > t.end) throw new UnsupportedImage(DAMAGED);
  if (size <= 4) return new Uint8Array(t.view.buffer, t.view.byteOffset + e.at + 8, 4).slice();
  const off = t.base + t.view.getUint32(e.at + 8, t.le);
  if (off < 0 || off + size > t.end) throw new UnsupportedImage(DAMAGED);
  return new Uint8Array(t.view.buffer, t.view.byteOffset + off, size).slice();
}

class Writer {
  private b = new Uint8Array(256);
  len = 0;
  constructor(private le: boolean) {}
  private grow(n: number) {
    if (this.len + n <= this.b.length) return;
    let s = this.b.length;
    while (s < this.len + n) s *= 2;
    const next = new Uint8Array(s);
    next.set(this.b.subarray(0, this.len));
    this.b = next;
  }
  u8(v: number) {
    this.grow(1);
    this.b[this.len++] = v & 255;
  }
  u16(v: number) {
    if (this.le) {
      this.u8(v);
      this.u8(v >> 8);
    } else {
      this.u8(v >> 8);
      this.u8(v);
    }
  }
  u32(v: number) {
    if (this.le) {
      this.u16(v);
      this.u16(v >>> 16);
    } else {
      this.u16(v >>> 16);
      this.u16(v);
    }
  }
  bytes(d: Uint8Array) {
    this.grow(d.length);
    this.b.set(d, this.len);
    this.len += d.length;
  }
  setU32(at: number, v: number) {
    const end = this.len;
    this.len = at;
    this.u32(v);
    this.len = end;
  }
  done() {
    return this.b.slice(0, this.len);
  }
}

function u32bytes(nums: number[], le: boolean): Uint8Array {
  const out = new Uint8Array(nums.length * 4);
  const view = new DataView(out.buffer);
  nums.forEach((n, i) => view.setUint32(i * 4, n, le));
  return out;
}

function writeIfd(w: Writer, t: Tiff, srcIfd: number): { start: number; nextPtr: number; srcNext: number } {
  const { entries, next } = readRawIfd(t, srcIfd);
  const compression = compressionOf(t, entries);
  if (!TIFF_SAFE_COMPRESSION.has(compression)) throw new UnsupportedImage(TIFF_UNSAFE);
  const strips = imageStrips(t, entries, compression);
  const tile = entries.some((e) => e.tag === 324) && !entries.some((e) => e.tag === 273);
  const offTag = tile ? 324 : 273;
  const cntTag = tile ? 325 : 279;
  interface Plan {
    tag: number;
    type: number;
    count: number;
    data: Uint8Array;
    inline: boolean;
  }
  const plans: Plan[] = [];
  for (const e of entries) {
    if (!TIFF_KEEP.has(e.tag)) continue;
    const size = (TYPE_SIZE[e.type] ?? 0) * e.count;
    const data = valueBytes(t, e);
    plans.push({ tag: e.tag, type: e.type, count: e.count, data, inline: size <= 4 });
  }
  const offData = u32bytes(
    strips.map(() => 0),
    t.le,
  );
  const cntData = u32bytes(
    strips.map((s) => s.length),
    t.le,
  );
  const items: Plan[] = [
    ...plans,
    { tag: offTag, type: 4, count: strips.length, data: offData, inline: strips.length === 1 },
    { tag: cntTag, type: 4, count: strips.length, data: cntData, inline: strips.length === 1 },
  ].sort((a, b) => a.tag - b.tag);
  const start = w.len;
  const ifdSize = 2 + items.length * 12 + 4;
  const overflow = items.reduce((n, it) => n + (it.inline ? 0 : it.data.length), 0);
  let writeAt = start + ifdSize + overflow;
  const view = new DataView(offData.buffer, offData.byteOffset, offData.byteLength);
  strips.forEach((s, i) => {
    view.setUint32(i * 4, writeAt, t.le);
    writeAt += s.length;
  });
  w.u16(items.length);
  const blobs: Uint8Array[] = [];
  let overflowAt = start + ifdSize;
  for (const it of items) {
    w.u16(it.tag);
    w.u16(it.type);
    w.u32(it.count);
    if (it.inline) {
      const four = new Uint8Array(4);
      four.set(it.data.subarray(0, Math.min(4, it.data.length)));
      w.bytes(four);
    } else {
      w.u32(overflowAt);
      overflowAt += it.data.length;
      blobs.push(it.data);
    }
  }
  const nextPtr = w.len;
  w.u32(0);
  for (const blob of blobs) w.bytes(blob);
  for (const s of strips) w.bytes(s);
  return { start, nextPtr, srcNext: next };
}

function readTiff(b: Uint8Array): PhotoMeta {
  const ex = readExif(b);
  let canStrip = true;
  let limit: LimitCode | undefined;
  try {
    const t = openTiff(b);
    const first = t.view.getUint32(4, t.le);
    const seen = new Set<number>();
    let ifd = first;
    while (ifd && !seen.has(ifd) && seen.size < 32) {
      seen.add(ifd);
      const { entries, next } = readRawIfd(t, ifd);
      const compression = compressionOf(t, entries);
      if (!TIFF_SAFE_COMPRESSION.has(compression)) throw new UnsupportedImage(TIFF_UNSAFE);
      imageStrips(t, entries, compression);
      ifd = next;
    }
  } catch (e) {
    canStrip = false;
    limit = e instanceof UnsupportedImage ? e.code : TIFF_UNSAFE;
  }
  return { format: "tiff", ...ex, canStrip, limit };
}

function stripTiff(b: Uint8Array): Uint8Array {
  const t = openTiff(b);
  const w = new Writer(t.le);
  w.u16(t.le ? 0x4949 : 0x4d4d);
  w.u16(42);
  w.u32(0);
  let src = t.view.getUint32(4, t.le);
  const seen = new Set<number>();
  let prevPtr = 4;
  let pages = 0;
  while (src && !seen.has(src) && seen.size < 32) {
    seen.add(src);
    const page = writeIfd(w, t, src);
    w.setU32(prevPtr, page.start);
    prevPtr = page.nextPtr;
    src = page.srcNext;
    pages++;
  }
  if (!pages || src) throw new UnsupportedImage(DAMAGED);
  return w.done();
}

// XMP
function coord(raw: string, ref: string | null): number | null {
  const hem = /[NSEW]$/i.exec(raw.trim())?.[0] ?? ref;
  const parts = raw
    .trim()
    .replace(/[NSEW]$/i, "")
    .trim()
    .split(",")
    .map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const deg = parts.length >= 2 ? parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600 : parts[0];
  if (!Number.isFinite(deg)) return null;
  return hem && /[SW]/i.test(hem) ? -Math.abs(deg) : deg;
}

/** GPS from an XMP packet. EXIF GPS stays preferred when both exist; this covers XMP-only files. */
function xmpGps(xml: string): PhotoMeta["gps"] {
  const slice = xml.length > 1_000_000 ? xml.slice(0, 1_000_000) : xml;
  const grab = (name: string) => {
    const re = new RegExp(String.raw`(?:^|[^A-Za-z0-9])${name}(?:\s*=\s*["']([^"']+)["']|\s*>\s*([^<]+))`, "i");
    const m = re.exec(slice);
    const v = (m?.[1] ?? m?.[2])?.trim();
    if (!v) return null;
    return v;
  };
  const lat = grab("GPSLatitude");
  const lon = grab("GPSLongitude");
  if (!lat || !lon) return null;
  const la = coord(lat, grab("GPSLatitudeRef"));
  const lo = coord(lon, grab("GPSLongitudeRef"));
  if (la === null || lo === null) return null;
  return { lat: la, lon: lo };
}

function absorbBytes(meta: Body, data: Uint8Array) {
  const text = latin1(data);
  noteGps(meta, xmpGps(text));
  let from = 0;
  while (from < data.length) {
    const at = indexOfBytes(data, "Exif\0\0", from);
    if (at < 0 || at + 14 > data.length) break;
    mergeExif(meta, data.subarray(at + 6));
    from = at + 6;
  }
}

// JPEG
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) => b.length > 8 && PNG_SIG.every((v, i) => b[i] === v);

interface Segment {
  marker: number;
  start: number;
  end: number;
  data: Uint8Array;
}

function jpegSegments(b: Uint8Array): { segments: Segment[]; scan: number } {
  const segments: Segment[] = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new UnsupportedImage(DAMAGED);
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return { segments, scan: i };
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new UnsupportedImage(DAMAGED);
    segments.push({ marker, start: i, end: i + 2 + len, data: b.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  throw new UnsupportedImage(DAMAGED);
}

/** Index just past the EOI marker. Bytes after it are a trailer, not part of the image. */
function jpegCut(b: Uint8Array, scan: number): number {
  if (scan + 4 > b.length) return b.length;
  const len = (b[scan + 2] << 8) | b[scan + 3];
  if (len < 2) return b.length;
  let i = scan + 2 + len;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const mark = i;
    do i++;
    while (i < b.length && b[i] === 0xff);
    if (i >= b.length) return b.length;
    const m = b[i++];
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9) return i;
    return mark;
  }
  return b.length;
}

const EXIF_HDR = "Exif\0\0";
const XMP_HDR = "http://ns.adobe.com/xap/1.0/";
/** APP1, APP3–APP13, APP15 and comments go. APP14 (Adobe color) stays. APP2 stays only for an ICC profile. */
const dropMarker = (m: number) => m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;
const isIcc = (data: Uint8Array) => startsWith(data, "ICC_PROFILE");
const dropSegment = (s: Segment) => (s.marker === 0xe2 ? !isIcc(s.data) : dropMarker(s.marker));

/** Second picture inside a Multi-Picture Format APP2. Offsets are from the TIFF header after "MPF\\0". */
function readMpf(payload: Uint8Array, meta: Body, depth: number) {
  if (!startsWith(payload, "MPF\0") || payload.length < 16) return;
  const tiff = payload.subarray(4);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = view.getUint16(0);
  if ((order !== 0x4949 && order !== 0x4d4d) || tiff.length < 8) return;
  const t: Tiff = { view, le: order === 0x4949, base: 0, end: tiff.length, bytes: tiff };
  const at = view.getUint32(4, t.le);
  if (at + 2 > t.end) return;
  const n = view.getUint16(at, t.le);
  let entry = 0;
  for (let i = 0; i < n && i < 512; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > t.end) return;
    if (view.getUint16(e, t.le) === 0xb002) entry = e;
  }
  if (!entry) return;
  const count = view.getUint32(entry + 4, t.le);
  const size = count;
  const valueAt = size <= 4 ? entry + 8 : view.getUint32(entry + 8, t.le);
  if (valueAt < 0 || valueAt + size > t.end) return;
  const rec = new DataView(tiff.buffer, tiff.byteOffset + valueAt, size);
  let found = false;
  for (let i = 0; i + 16 <= size; i += 16) {
    const bytes = rec.getUint32(i + 4, t.le);
    const off = rec.getUint32(i + 8, t.le);
    if (off === 0 || bytes < 4 || off + bytes > tiff.length) continue;
    const slice = tiff.subarray(off, off + bytes);
    found = true;
    if (isJpeg(slice)) {
      try {
        const nested = readJpeg(slice, depth + 1);
        noteGps(meta, nested.gps);
      } catch {
        /* The second picture is still listed below. */
      }
    } else absorbBytes(meta, slice);
  }
  if (found) meta.fields.push({ kind: "credentials", tag: "Second picture", value: `${payload.length} B` });
}

function readJpeg(b: Uint8Array, depth = 0): PhotoMeta {
  const { segments, scan } = jpegSegments(b);
  const meta: Body = body();
  const extra: MetaField[] = [];
  for (const s of segments) {
    if (s.marker === 0xe1 && startsWith(s.data, EXIF_HDR)) mergeExif(meta, s.data.subarray(6));
    else if (s.marker === 0xe1 && startsWith(s.data, XMP_HDR)) {
      extra.push({ kind: "xmp", tag: "XMP", value: `${s.data.length} B` });
      noteGps(meta, xmpGps(latin1(s.data)));
    } else if (s.marker === 0xed) extra.push({ kind: "iptc", tag: "IPTC", value: `${s.data.length} B` });
    else if (s.marker === 0xfe)
      extra.push({ kind: "comment", tag: "Comment", value: clean(new TextDecoder().decode(s.data)).slice(0, 120) });
    else if (s.marker === 0xe2 && startsWith(s.data, "MPF\0") && depth < 3) readMpf(s.data, meta, depth);
    else if (s.marker === 0xeb) {
      extra.push({ kind: "credentials", tag: "Content credentials", value: `${s.data.length} B` });
      absorbBytes(meta, s.data);
    }
  }
  const end = jpegCut(b, scan);
  if (end < b.length) {
    const trailer = b.subarray(end);
    extra.push({ kind: "comment", tag: "Trailing data", value: `${trailer.length} B` });
    if (depth < 3 && isJpeg(trailer)) {
      try {
        noteGps(meta, readJpeg(trailer, depth + 1).gps);
      } catch {
        /* The trailer is already listed. */
      }
    } else absorbBytes(meta, trailer);
  }
  return { format: "jpeg", ...meta, fields: [...meta.fields, ...extra] };
}

/** Minimal big-endian EXIF with only Orientation (tag 0x0112). */
function orientationApp1(o: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
  const bodyBytes = [...EXIF_HDR].map((c) => c.charCodeAt(0)).concat(tiff);
  const len = bodyBytes.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...bodyBytes]);
}

function stripJpeg(b: Uint8Array, orientation: number): Uint8Array {
  const { segments, scan } = jpegSegments(b);
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let added = orientation === 1;
  for (const s of segments) {
    if (dropSegment(s)) continue;
    parts.push(b.subarray(s.start, s.end));
    // after APP0 (JFIF) when present, otherwise first thing
    if (!added && s.marker === 0xe0) {
      parts.push(orientationApp1(orientation));
      added = true;
    }
  }
  if (!added) parts.splice(1, 0, orientationApp1(orientation));
  parts.push(b.subarray(scan, jpegCut(b, scan)));
  return concat(parts);
}

// PNG
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME", "caBX"]);

function pngChunks(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: { type: string; start: number; end: number; data: Uint8Array }[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = view.getUint32(i);
    const type = latin1(b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (len < 0 || end > b.length) throw new UnsupportedImage(DAMAGED);
    chunks.push({ type, start: i, end, data: b.subarray(i + 8, i + 8 + len) });
    i = end;
    if (type === "IEND") break;
  }
  return chunks;
}

/** A tIME chunk: year (2 bytes), month, day, hour, minute, second, in UTC (PNG spec 11.3.6.1). Not just the year. */
function pngTime(d: Uint8Array): string {
  const year = ((d[0] ?? 0) << 8) | (d[1] ?? 0);
  if (d.length < 7) return String(year);
  const p = (n: number | undefined) => String(n ?? 0).padStart(2, "0");
  return `${year}-${p(d[2])}-${p(d[3])} ${p(d[4])}:${p(d[5])}:${p(d[6])} UTC`;
}

function readPng(b: Uint8Array): PhotoMeta {
  const meta: Body = body();
  const extra: MetaField[] = [];
  for (const c of pngChunks(b)) {
    if (c.type === "eXIf") mergeExif(meta, c.data);
    else if (c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt") {
      const nul = c.data.indexOf(0);
      const key = latin1(c.data.subarray(0, nul < 0 ? Math.min(c.data.length, 80) : nul));
      const value =
        c.type === "tEXt" && nul >= 0
          ? clean(latin1(c.data.subarray(nul + 1, nul + 241))).slice(0, 120)
          : `${c.data.length} B`;
      extra.push({ kind: "text", tag: key || c.type, value });
      if (c.type !== "zTXt") noteGps(meta, xmpGps(latin1(c.data)));
    } else if (c.type === "tIME") extra.push({ kind: "date", tag: "Modified", value: pngTime(c.data) });
    else if (c.type === "caBX") {
      absorbBytes(meta, c.data);
      extra.push({ kind: "credentials", tag: "Content credentials", value: `${c.data.length} B` });
    }
  }
  return { format: "png", ...meta, fields: [...meta.fields, ...extra] };
}

function stripPng(b: Uint8Array): Uint8Array {
  return concat([
    b.subarray(0, 8),
    ...pngChunks(b)
      .filter((c) => !PNG_DROP.has(c.type))
      .map((c) => b.subarray(c.start, c.end)),
  ]);
}

// WebP
const isWebp = (b: Uint8Array) => b.length > 12 && startsWith(b, "RIFF") && latin1(b.subarray(8, 12)) === "WEBP";

function webpChunks(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: { type: string; start: number; end: number; data: Uint8Array }[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = latin1(b.subarray(i, i + 4));
    const size = view.getUint32(i + 4, true);
    const dataEnd = i + 8 + size;
    if (size < 0 || dataEnd > b.length) throw new UnsupportedImage(DAMAGED);
    const end = Math.min(b.length, dataEnd + (size & 1));
    chunks.push({ type, start: i, end, data: b.subarray(i + 8, dataEnd) });
    i = end;
  }
  return chunks;
}

function webpExif(data: Uint8Array): Uint8Array {
  if (startsWith(data, EXIF_HDR)) return data.subarray(6);
  return data;
}

function readWebp(b: Uint8Array): PhotoMeta {
  const meta: Body = body();
  for (const c of webpChunks(b)) {
    if (c.type === "EXIF") {
      mergeExif(meta, webpExif(c.data));
      meta.fields.push({ kind: "xmp", tag: "EXIF", value: `${c.data.length} B` });
    } else if (c.type === "XMP ") {
      meta.fields.push({ kind: "xmp", tag: "XMP", value: `${c.data.length} B` });
      noteGps(meta, xmpGps(latin1(c.data)));
    }
  }
  // The byte-count rows are not privacy fields by themselves; GPS and camera already came from the EXIF block.
  meta.fields = meta.fields.filter((f) => f.tag !== "EXIF");
  return { format: "webp", ...meta };
}

function stripWebp(b: Uint8Array): Uint8Array {
  const kept = webpChunks(b)
    .filter((c) => c.type !== "EXIF" && c.type !== "XMP ")
    .map((c) => {
      if (c.type !== "VP8X" || c.data.length < 1) return b.subarray(c.start, c.end);
      const copy = b.slice(c.start, c.end);
      copy[8] &= ~0x0c; // clear EXIF (0x08) and XMP (0x04); alpha, ICC and animation stay
      return copy;
    });
  const chunks = concat(kept);
  const out = concat([b.subarray(0, 12), chunks]);
  const view = new DataView(out.buffer);
  view.setUint32(4, out.length - 8, true);
  return out;
}

// PDF
const PDF_KEYS: { name: string; tag: string; kind: MetaKind }[] = [
  { name: "Author", tag: "Author", kind: "author" },
  { name: "Title", tag: "Title", kind: "document" },
  { name: "Subject", tag: "Subject", kind: "text" },
  { name: "Keywords", tag: "Keywords", kind: "text" },
  { name: "Creator", tag: "Creator", kind: "software" },
  { name: "Producer", tag: "Producer", kind: "software" },
  { name: "CreationDate", tag: "Created", kind: "date" },
  { name: "ModDate", tag: "Modified", kind: "date" },
];

const isWs = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isPdf = (b: Uint8Array) => startsWith(b, "%PDF-");

function skipWs(b: Uint8Array, i: number, end: number) {
  while (i < end && isWs(b[i])) i++;
  return i;
}
function readIntAt(b: Uint8Array, i: number, end: number): { n: number; i: number } | null {
  i = skipWs(b, i, end);
  if (i >= end || b[i] < 48 || b[i] > 57) return null;
  let n = 0;
  while (i < end && b[i] >= 48 && b[i] <= 57) {
    n = n * 10 + (b[i] - 48);
    if (n > 2_000_000_000) return null;
    i++;
  }
  return { n, i };
}

interface XrefEntry {
  id: number;
  offset: number;
  used: boolean;
}
interface XrefSection {
  entries: XrefEntry[];
  prev: number | null;
  info: number | null;
  encrypt: boolean;
}

function parseXref(b: Uint8Array, at: number): XrefSection | null {
  const end = Math.min(b.length, at + 4_000_000);
  if (latin1(b.subarray(at, Math.min(end, at + 4))) !== "xref") return null;
  let i = skipWs(b, at + 4, end);
  const entries: XrefEntry[] = [];
  while (i < end) {
    const peek = latin1(b.subarray(i, Math.min(end, i + 7)));
    if (peek.startsWith("trailer")) break;
    const start = readIntAt(b, i, end);
    if (!start) return null;
    const count = readIntAt(b, start.i, end);
    if (!count || count.n > 200_000) return null;
    i = skipWs(b, count.i, end);
    for (let n = 0; n < count.n; n++) {
      if (i + 18 > end) return null;
      const offset = Number(latin1(b.subarray(i, i + 10)));
      const flag = latin1(b.subarray(i + 17, i + 18));
      if (!Number.isFinite(offset) || (flag !== "n" && flag !== "f")) return null;
      entries.push({ id: start.n + n, offset, used: flag === "n" });
      i += 18;
      if (b[i] === 13) i++;
      if (b[i] === 10) i++;
      else if (b[i - 1] !== 10 && b[i - 1] !== 13) {
        while (i < end && b[i] !== 10 && b[i] !== 13) i++;
        i = skipWs(b, i, end);
      }
    }
    i = skipWs(b, i, end);
  }
  if (!latin1(b.subarray(i, i + 7)).startsWith("trailer")) return null;
  const trailerEnd = indexOfBytes(b, "startxref", i, end);
  const trailer = latin1(b.subarray(i, trailerEnd < 0 ? Math.min(end, i + 8192) : trailerEnd));
  const info = /\/Info\s+(\d+)\s+\d+\s+R/.exec(trailer);
  const prev = /\/Prev\s+(\d+)/.exec(trailer);
  return {
    entries,
    prev: prev ? Number(prev[1]) : null,
    info: info ? Number(info[1]) : null,
    encrypt: /\/Encrypt\b/.test(trailer),
  };
}

function looksLikeObject(b: Uint8Array, offset: number) {
  return /^\d+\s+\d+\s+obj/.test(latin1(b.subarray(offset, Math.min(b.length, offset + 32))));
}

function directLength(dict: Uint8Array): number | "indirect" | null {
  const s = latin1(dict);
  const m = /\/Length\s+(\d+)/.exec(s);
  if (m?.index === undefined) return null;
  if (/^\s+\d/.test(s.slice(m.index + m[0].length))) return "indirect";
  return Number(m[1]);
}

function sliceObject(b: Uint8Array, offset: number): { start: number; end: number } | null {
  const limit = Math.min(b.length, offset + 2_000_000);
  if (!looksLikeObject(b, offset)) return null;
  const stream = indexOfBytes(b, "stream", offset, limit);
  const early = indexOfBytes(b, "endobj", offset, stream < 0 ? limit : stream);
  if (stream < 0 || (early >= 0 && early < stream)) {
    const end = indexOfBytes(b, "endobj", offset, limit);
    return end < 0 ? null : { start: offset, end: end + 6 };
  }
  const len = directLength(b.subarray(offset, stream));
  let contentEnd: number;
  if (typeof len === "number") {
    let i = stream + 6;
    if (b[i] === 13 && b[i + 1] === 10) i += 2;
    else if (b[i] === 10 || b[i] === 13) i += 1;
    else return null;
    contentEnd = i + len;
    if (contentEnd > limit) return null;
  } else {
    const es = indexOfBytes(b, "endstream", stream + 6, limit);
    if (es < 0) return null;
    contentEnd = es;
  }
  const end = indexOfBytes(b, "endobj", contentEnd, limit);
  return end < 0 ? null : { start: offset, end: end + 6 };
}

function literalEnd(b: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < b.length && i < open + 100_000; i++) {
    if (b[i] === 0x5c) {
      i++;
      continue;
    }
    if (b[i] === 0x28) depth++;
    else if (b[i] === 0x29) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function pdfString(
  b: Uint8Array,
  i: number,
): { text: string; open: number; close: number; hex: boolean } | "ref" | null {
  i = skipWs(b, i, b.length);
  if (i >= b.length) return null;
  if (b[i] >= 48 && b[i] <= 57) return "ref";
  if (b[i] === 0x28) {
    const close = literalEnd(b, i);
    if (close < 0) return null;
    return { text: clean(latin1(b.subarray(i + 1, close))), open: i, close, hex: false };
  }
  if (b[i] === 0x3c && b[i + 1] !== 0x3c) {
    const close = indexOfBytes(b, ">", i + 1, Math.min(b.length, i + 100_000));
    if (close < 0) return null;
    const hex = latin1(b.subarray(i + 1, close)).replace(/\s+/g, "");
    let text = "";
    for (let k = 0; k + 1 < hex.length; k += 2) {
      const n = Number.parseInt(hex.slice(k, k + 2), 16);
      if (Number.isFinite(n)) text += String.fromCharCode(n);
    }
    // UTF-16 BE hex strings start with BOM.
    if (text.charCodeAt(0) === 0xfeff) {
      let u = "";
      for (let k = 1; k + 1 < text.length; k += 2)
        u += String.fromCharCode((text.charCodeAt(k) << 8) | text.charCodeAt(k + 1));
      text = u;
    }
    return { text: clean(text), open: i, close, hex: true };
  }
  return null;
}

interface PdfPlan {
  meta: Body;
  clean: Uint8Array | null;
}

function planPdf(b: Uint8Array): PdfPlan {
  let startAt = -1;
  for (let from = Math.max(0, b.length - 8192); from < b.length;) {
    const at = indexOfBytes(b, "startxref", from);
    if (at < 0) break;
    startAt = at;
    from = at + 9;
  }
  if (startAt < 0) throw new UnsupportedImage(PDF_STRUCT);
  const pos = readIntAt(b, startAt + "startxref".length, Math.min(b.length, startAt + 64));
  if (!pos) throw new UnsupportedImage(PDF_STRUCT);
  const all: { id: number; offset: number }[] = [];
  const latest = new Map<number, number>();
  let infoId: number | null = null;
  let encrypt = false;
  let at = pos.n;
  const seen = new Set<number>();
  while (at && !seen.has(at) && seen.size < 32) {
    seen.add(at);
    const sec = parseXref(b, at);
    if (!sec) throw new UnsupportedImage(PDF_STRUCT);
    for (const e of sec.entries) {
      if (!e.used || e.offset <= 0) continue;
      all.push({ id: e.id, offset: e.offset });
      if (!latest.has(e.id)) latest.set(e.id, e.offset);
    }
    if (infoId === null && sec.info) infoId = sec.info;
    if (sec.encrypt) encrypt = true;
    at = sec.prev ?? 0;
  }
  if (!all.length) throw new UnsupportedImage(PDF_STRUCT);
  const meta = body();
  let unsafe = encrypt;
  let limit: LimitCode | undefined = encrypt ? PDF_ENCRYPT : undefined;
  const blanks: { open: number; close: number; hex: boolean }[] = [];
  const streams: { start: number; end: number }[] = [];
  let showedInfo = false;
  for (const item of all) {
    const range = sliceObject(b, item.offset);
    if (!range) {
      unsafe = true;
      limit ??= PDF_STRUCT;
      continue;
    }
    const obj = b.subarray(range.start, range.end);
    const text = latin1(obj);
    if (/\/Type\s*\/ObjStm\b/.test(text) || /\/Encrypt\b/.test(text)) {
      unsafe = true;
      limit = /\/Encrypt\b/.test(text) ? PDF_ENCRYPT : PDF_UNSAFE;
    }
    const isMeta = /\/Type\s*\/Metadata\b/.test(text) || /\/Subtype\s*\/XML\b/.test(text);
    const streamAt = indexOfBytes(obj, "stream");
    if (isMeta) {
      const dict = streamAt < 0 ? obj : obj.subarray(0, streamAt);
      const len = directLength(dict);
      const filtered = /\/Filter\s*\//.test(latin1(dict)) && !/\/Filter\s*\/Null\b/.test(latin1(dict));
      if (filtered || len === "indirect" || len === null || streamAt < 0) {
        unsafe = true;
        limit ??= PDF_UNSAFE;
      } else {
        let i = streamAt + 6;
        if (obj[i] === 13 && obj[i + 1] === 10) i += 2;
        else if (obj[i] === 10 || obj[i] === 13) i += 1;
        const start = range.start + i;
        const end = start + len;
        if (end <= range.end) {
          noteGps(meta, xmpGps(latin1(b.subarray(start, end))));
          streams.push({ start, end });
        } else {
          unsafe = true;
          limit ??= PDF_UNSAFE;
        }
      }
    }
    if (streamAt >= 0) continue;
    const newest = latest.get(item.id) === item.offset;
    const show = newest && (item.id === infoId || (infoId === null && !showedInfo));
    for (const key of PDF_KEYS) {
      let from = 0;
      while (from < obj.length) {
        const hit = indexOfBytes(obj, `/${key.name}`, from);
        if (hit < 0) break;
        const after = hit + key.name.length + 1;
        const boundary = obj[after];
        if (boundary !== undefined && /[A-Za-z0-9]/.test(String.fromCharCode(boundary))) {
          from = after;
          continue;
        }
        const value = pdfString(obj, after);
        if (value === "ref") {
          unsafe = true;
          limit ??= PDF_UNSAFE;
        } else if (value?.text) {
          if (show) {
            showedInfo = true;
            meta.fields.push({ kind: key.kind, tag: key.tag, value: value.text.slice(0, 180) });
          }
          blanks.push({ open: range.start + value.open, close: range.start + value.close, hex: value.hex });
        }
        from = value && value !== "ref" ? value.close + 1 : after + 1;
      }
    }
  }
  if (unsafe) {
    meta.canStrip = false;
    meta.limit = limit ?? PDF_UNSAFE;
    return { meta, clean: null };
  }
  const clean = new Uint8Array(b);
  for (const edit of blanks) {
    for (let i = edit.open + 1; i < edit.close; i++) {
      if (edit.hex) {
        if (!isWs(clean[i])) clean[i] = 0x30;
      } else clean[i] = 0x20;
    }
  }
  for (const s of streams) clean.fill(0x20, s.start, s.end);
  return { meta, clean };
}

function readPdf(b: Uint8Array): PhotoMeta {
  const { meta } = planPdf(b);
  return { format: "pdf", ...meta };
}
function stripPdf(b: Uint8Array): Uint8Array {
  const { meta, clean } = planPdf(b);
  if (!clean) throw new UnsupportedImage(meta.limit ?? PDF_UNSAFE);
  return clean;
}

// HEIC / HEIF
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];

interface Box {
  type: string;
  contentStart: number;
  end: number;
}

function readBoxes(b: Uint8Array, start: number, end: number): Box[] | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let i = start;
  while (i + 8 <= end) {
    if (end - i < 8) break;
    const size32 = view.getUint32(i);
    const type = latin1(b.subarray(i + 4, i + 8));
    let header = 8;
    let size = size32;
    if (size32 === 1) {
      if (i + 16 > end) return null;
      if (view.getUint32(i + 8) !== 0) return null;
      size = view.getUint32(i + 12);
      header = 16;
    } else if (size32 === 0) size = end - i;
    if (size < header || i + size > end) return null;
    out.push({ type, contentStart: i + header, end: i + size });
    i += size;
  }
  return out;
}

function heicBrand(b: Uint8Array): boolean {
  // The file only has to start with a HEIC ftyp. A broken box after that is still HEIC, reported as unsafe to clean.
  if (b.length < 16) return false;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = view.getUint32(0);
  if (latin1(b.subarray(4, 8)) !== "ftyp" || size < 16 || size > b.length) return false;
  const data = b.subarray(8, size);
  const major = latin1(data.subarray(0, 4));
  if (major === "avif" || major === "avis") return false;
  const brands = [major];
  for (let i = 8; i + 4 <= data.length; i += 4) brands.push(latin1(data.subarray(i, i + 4)));
  return brands.some((x) => HEIC_BRANDS.has(x));
}

function cstr(b: Uint8Array, at: number, end: number): { text: string; next: number } | null {
  let i = at;
  while (i < end && b[i] !== 0) i++;
  if (i >= end) return null;
  return { text: latin1(b.subarray(at, i)), next: i + 1 };
}

function parseInfe(b: Uint8Array, box: Box): { id: number; kind: "exif" | "xmp" } | null | "unsafe" {
  if (box.contentStart + 4 > box.end) return "unsafe";
  const version = b[box.contentStart];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = box.contentStart + 4;
  let id: number;
  if (version === 2) {
    if (p + 8 > box.end) return "unsafe";
    id = view.getUint16(p);
    p += 4;
  } else if (version === 3) {
    if (p + 10 > box.end) return "unsafe";
    id = view.getUint32(p);
    p += 6;
  } else return "unsafe";
  const type = latin1(b.subarray(p, p + 4));
  p += 4;
  const name = cstr(b, p, box.end);
  if (!name) return "unsafe";
  if (type === "Exif") return { id, kind: "exif" };
  if (type === "mime" || type === "xml ") {
    const ct = cstr(b, name.next, box.end);
    const text = `${name.text} ${ct?.text ?? ""}`.toLowerCase();
    if (type === "xml " || text.includes("xmp") || text.includes("xml")) return { id, kind: "xmp" };
  }
  return null;
}

function parseIinf(b: Uint8Array, box: Box): Map<number, "exif" | "xmp"> | "unsafe" {
  if (box.contentStart + 6 > box.end) return "unsafe";
  const version = b[box.contentStart];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = box.contentStart + 4;
  if (version === 0) {
    if (p + 2 > box.end) return "unsafe";
    p += 2;
  } else if (version === 1) {
    if (p + 4 > box.end) return "unsafe";
    view.getUint32(p);
    p += 4;
  } else return "unsafe";
  const children = readBoxes(b, p, box.end);
  if (!children) return "unsafe";
  const map = new Map<number, "exif" | "xmp">();
  for (const child of children) {
    if (child.type !== "infe") continue;
    const info = parseInfe(b, child);
    if (info === "unsafe") return "unsafe";
    if (info) map.set(info.id, info.kind);
  }
  return map;
}

interface ItemLoc {
  construction: number;
  dataRef: number;
  extents: { start: number; end: number }[];
}

function parseIloc(b: Uint8Array, box: Box): Map<number, ItemLoc> | "unsafe" {
  if (box.contentStart + 6 > box.end) return "unsafe";
  const version = b[box.contentStart];
  if (version > 2) return "unsafe";
  const offsetSize = b[box.contentStart + 4] >> 4;
  const lengthSize = b[box.contentStart + 4] & 0xf;
  const baseSize = b[box.contentStart + 5] >> 4;
  const indexSize = version >= 1 ? b[box.contentStart + 5] & 0xf : 0;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = box.contentStart + 6;
  const read = (n: number): number | null => {
    if (n === 0) return 0;
    if (n !== 1 && n !== 2 && n !== 4 && n !== 8) return null;
    if (p + n > box.end) return null;
    if (n === 8) {
      const high = view.getUint32(p);
      p += 4;
      const low = view.getUint32(p);
      p += 4;
      return high === 0 ? low : null;
    }
    let x = 0;
    for (let i = 0; i < n; i++) x = (x << 8) | b[p++];
    return x >>> 0;
  };
  const count = version < 2 ? read(2) : read(4);
  if (count === null || count > 10_000) return "unsafe";
  const map = new Map<number, ItemLoc>();
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? read(2) : read(4);
    if (id === null) return "unsafe";
    let construction = 0;
    if (version >= 1) {
      const c = read(2);
      if (c === null) return "unsafe";
      construction = c & 0xf;
    }
    const dataRef = read(2);
    const base = read(baseSize);
    const extents = read(2);
    if (dataRef === null || base === null || extents === null || extents > 64) return "unsafe";
    const list: { start: number; end: number }[] = [];
    for (let e = 0; e < extents; e++) {
      if (version >= 1 && indexSize > 0 && read(indexSize) === null) return "unsafe";
      const off = read(offsetSize);
      const len = read(lengthSize);
      if (off === null || len === null) return "unsafe";
      const start = base + off;
      list.push({ start, end: start + len });
    }
    map.set(id, { construction, dataRef, extents: list });
  }
  return map;
}

function exifBytes(payload: Uint8Array): Uint8Array | null {
  if (payload.length >= 8) {
    const off = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
    if (off >= 4 && off + 8 <= payload.length) {
      const at = payload.subarray(off);
      const order = at[0] === 0x49 ? 0x4949 : at[0] === 0x4d ? 0x4d4d : 0;
      if (order === 0x4949 || order === 0x4d4d) return at;
    }
  }
  if (startsWith(payload, EXIF_HDR)) return payload.subarray(6);
  if (payload.length > 4 && (payload[0] === 0x49 || payload[0] === 0x4d)) return payload;
  return null;
}

function heicPlan(b: Uint8Array): { meta: Body; ranges: [number, number][] } {
  const meta = body();
  const fail = () => {
    meta.canStrip = false;
    meta.limit = HEIC_UNSAFE;
    return { meta, ranges: [] as [number, number][] };
  };
  const top = readBoxes(b, 0, b.length);
  if (!top) return fail();
  const ranges: [number, number][] = [];
  const takeUuid = (boxes: Box[]) => {
    for (const box of boxes) {
      if (box.type !== "uuid" || box.contentStart + 16 > box.end) continue;
      if (!XMP_UUID.every((v, i) => b[box.contentStart + i] === v)) continue;
      const start = box.contentStart + 16;
      noteGps(meta, xmpGps(latin1(b.subarray(start, box.end))));
      ranges.push([start, box.end]);
    }
  };
  takeUuid(top);
  const container = top.find((x) => x.type === "meta");
  if (!container || container.contentStart + 4 > container.end) return fail();
  const children = readBoxes(b, container.contentStart + 4, container.end);
  if (!children) return fail();
  takeUuid(children);
  const iinf = children.find((x) => x.type === "iinf");
  const iloc = children.find((x) => x.type === "iloc");
  if (!iinf || !iloc) return fail();
  const types = parseIinf(b, iinf);
  const locs = parseIloc(b, iloc);
  if (types === "unsafe" || locs === "unsafe") return fail();
  let unsafe = false;
  for (const [id, kind] of types) {
    const loc = locs.get(id);
    if (loc?.construction !== 0 || loc.dataRef !== 0) {
      unsafe = true;
      continue;
    }
    for (const ext of loc.extents) {
      if (ext.start < 0 || ext.end < ext.start || ext.end > b.length) {
        unsafe = true;
        continue;
      }
      const payload = b.subarray(ext.start, ext.end);
      if (kind === "exif") {
        const tiff = exifBytes(payload);
        if (tiff) mergeExif(meta, tiff);
      } else noteGps(meta, xmpGps(latin1(payload)));
      ranges.push([ext.start, ext.end]);
    }
  }
  if (unsafe) return fail();
  return { meta, ranges };
}

function readHeic(b: Uint8Array): PhotoMeta {
  return { format: "heic", ...heicPlan(b).meta };
}
function stripHeic(b: Uint8Array): Uint8Array {
  const plan = heicPlan(b);
  if (!plan.meta.canStrip) throw new UnsupportedImage(plan.meta.limit ?? HEIC_UNSAFE);
  if (!plan.ranges.length) return b.slice();
  const out = new Uint8Array(b);
  for (const [start, end] of plan.ranges) out.fill(0, start, end);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function tiffKind(b: Uint8Array): "std" | "big" | null {
  if (b.length < 4) return null;
  const ii = b[0] === 0x49 && b[1] === 0x49;
  const mm = b[0] === 0x4d && b[1] === 0x4d;
  if (!ii && !mm) return null;
  const magic = ii ? b[2] | (b[3] << 8) : (b[2] << 8) | b[3];
  if (magic === 42) return "std";
  if (magic === 43) return "big";
  return null;
}

// API
export function readPhotoMeta(b: Uint8Array): PhotoMeta {
  if (isJpeg(b)) return readJpeg(b);
  if (isPng(b)) return readPng(b);
  if (isWebp(b)) return readWebp(b);
  if (isPdf(b)) return readPdf(b);
  if (heicBrand(b)) return readHeic(b);
  const tiff = tiffKind(b);
  if (tiff === "big") throw new UnsupportedImage(TIFF_UNSAFE);
  if (tiff === "std") return readTiff(b);
  throw new UnsupportedImage(FORMAT);
}

export function stripPhotoMeta(b: Uint8Array): Uint8Array {
  if (isJpeg(b)) return stripJpeg(b, readJpeg(b).orientation);
  if (isPng(b)) return stripPng(b);
  if (isWebp(b)) return stripWebp(b);
  if (isPdf(b)) return stripPdf(b);
  if (heicBrand(b)) return stripHeic(b);
  const tiff = tiffKind(b);
  if (tiff === "big") throw new UnsupportedImage(TIFF_UNSAFE);
  if (tiff === "std") {
    const meta = readTiff(b);
    if (!meta.canStrip) throw new UnsupportedImage(meta.limit ?? TIFF_UNSAFE);
    return stripTiff(b);
  }
  throw new UnsupportedImage(FORMAT);
}
