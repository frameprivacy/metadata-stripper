import { expect, test } from "vitest";
import { LIMITS, readPhotoMeta, stripPhotoMeta, UnsupportedImage } from "../src/index.js";
import { gpsJpeg } from "./fixtures/gps-jpeg.js";

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function segment(marker: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (data.length + 2) >> 8;
  out[3] = (data.length + 2) & 0xff;
  out.set(data, 4);
  return out;
}
const SOS = Uint8Array.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0x03, 0xff, 0xd9]);
const jpeg = (parts: Uint8Array[], trailer = new Uint8Array()) =>
  concat([Uint8Array.from([0xff, 0xd8]), ...parts, SOS, trailer]);

function exifTiff(src: Uint8Array): Uint8Array {
  for (let i = 0; i + 10 < src.length; i++) {
    if (src[i] === 0xff && src[i + 1] === 0xe1 && src[i + 4] === 0x45) {
      const len = (src[i + 2] << 8) | src[i + 3];
      return src.subarray(i + 10, i + 2 + len);
    }
  }
  throw new Error("fixture has no EXIF");
}

function mpf(embedded: Uint8Array): Uint8Array {
  const entries = new Uint8Array(32);
  const rec = new DataView(entries.buffer);
  rec.setUint32(20, embedded.length, true);
  rec.setUint32(24, 58, true);
  const ifd = new Uint8Array(18);
  const iv = new DataView(ifd.buffer);
  iv.setUint16(0, 1, true);
  iv.setUint16(2, 0xb002, true);
  iv.setUint16(4, 7, true);
  iv.setUint32(6, 32, true);
  iv.setUint32(10, 26, true);
  const header = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  return concat([text("MPF\0"), header, ifd, entries, embedded]);
}

test("a second APP2 picture is shown and removed, and an ICC profile stays", () => {
  const embedded = gpsJpeg();
  const icc = segment(0xe2, text("ICC_PROFILE\0abc"));
  const src = jpeg([icc, segment(0xe2, mpf(embedded))]);
  const meta = readPhotoMeta(src);
  expect(meta.gps?.lat).toBeCloseTo(49.25, 5);
  expect(meta.gps?.lon).toBeCloseTo(-123.1, 5);
  expect(meta.fields.some((f) => f.tag === "Second picture")).toBe(true);
  const out = stripPhotoMeta(src);
  expect(latin1(out)).toContain("ICC_PROFILE");
  expect(latin1(out)).not.toContain("MPF");
  expect(readPhotoMeta(out).gps).toBeNull();
  expect(readPhotoMeta(out).fields.some((f) => f.tag === "Second picture")).toBe(false);
});

test("bytes after the JPEG end marker are not copied into the clean file", () => {
  const trailer = text("SECRETLOC");
  const src = jpeg([], trailer);
  expect(readPhotoMeta(src).fields.some((f) => f.tag === "Trailing data")).toBe(true);
  const out = stripPhotoMeta(src);
  expect(latin1(out)).not.toContain("SECRETLOC");
  expect([...out.slice(-2)]).toEqual([0xff, 0xd9]);
  expect(out.length).toBe(stripPhotoMeta(jpeg([])).length);
});

test("a location that exists only in XMP raises the same GPS warning", () => {
  const xml =
    '<rdf:RDF xmlns:exif="http://ns.adobe.com/exif/1.0/"><exif:GPSLatitude>49,15.0N</exif:GPSLatitude><exif:GPSLongitude>123,6.0W</exif:GPSLongitude></rdf:RDF>';
  const src = jpeg([segment(0xe1, text(`http://ns.adobe.com/xap/1.0/\0${xml}`))]);
  const meta = readPhotoMeta(src);
  expect(meta.gps?.lat).toBeCloseTo(49.25, 5);
  expect(meta.gps?.lon).toBeCloseTo(-123.1, 5);
  expect(meta.fields.some((f) => f.kind === "location")).toBe(true);
  expect(readPhotoMeta(stripPhotoMeta(src)).gps).toBeNull();
});

test("PNG content credentials are listed and removed", () => {
  const xml = text("<exif:GPSLatitude>49,15.0N</exif:GPSLatitude><exif:GPSLongitude>123,6.0W</exif:GPSLongitude>");
  const src = png([chunk("caBX", xml), chunk("IEND", new Uint8Array())]);
  const meta = readPhotoMeta(src);
  expect(meta.fields.some((f) => f.tag === "Content credentials")).toBe(true);
  expect(meta.gps?.lat).toBeCloseTo(49.25, 5);
  const out = stripPhotoMeta(src);
  expect(latin1(out)).not.toContain("GPSLatitude");
  expect(latin1(out)).not.toContain("caBX");
  expect(readPhotoMeta(out).gps).toBeNull();
  expect(readPhotoMeta(out).fields).toEqual([]);
});

test("a PNG modification time keeps the full date and time, not just the year", () => {
  const time = Uint8Array.from([0x07, 0xe8, 5, 1, 13, 4, 9]); // 2024-05-01 13:04:09 UTC
  const src = png([chunk("tIME", time), chunk("IEND", new Uint8Array())]);
  expect(readPhotoMeta(src).fields).toContainEqual({ kind: "date", tag: "Modified", value: "2024-05-01 13:04:09 UTC" });
  expect(readPhotoMeta(stripPhotoMeta(src)).fields).toEqual([]);
});

test("WebP EXIF and XMP are read and dropped without touching the picture chunk", () => {
  const picture = Uint8Array.from([1, 2, 3, 4]);
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08;
  const src = webp([webpChunk("VP8X", vp8x), webpChunk("VP8 ", picture), webpChunk("EXIF", exifTiff(gpsJpeg()))]);
  const meta = readPhotoMeta(src);
  expect(meta.format).toBe("webp");
  expect(meta.gps?.lat).toBeCloseTo(49.25, 5);
  expect(meta.orientation).toBe(6);
  const out = stripPhotoMeta(src);
  expect(latin1(out)).not.toContain("Acme");
  expect([...out.slice(out.length - 4)]).toEqual([1, 2, 3, 4]);
  expect(out[20] & 0x08).toBe(0);
  expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  expect(readPhotoMeta(out).gps).toBeNull();
});

test("TIFF keeps the image strips and orientation, and drops GPS and the artist", () => {
  const { file, pixels } = sampleTiff();
  const meta = readPhotoMeta(file);
  expect(meta.format).toBe("tiff");
  expect(meta.gps?.lat).toBeCloseTo(49.25, 5);
  expect(meta.orientation).toBe(6);
  expect(meta.fields.some((f) => f.value === "SECRETLOC")).toBe(true);
  const out = stripPhotoMeta(file);
  expect(latin1(out)).not.toContain("SECRETLOC");
  expect(includes(out, pixels)).toBe(true);
  const again = readPhotoMeta(out);
  expect(again.gps).toBeNull();
  expect(again.orientation).toBe(6);
  expect(again.fields).toEqual([]);
});

test("an uncompressed PDF loses its author and XMP location, and stays a PDF", () => {
  const src = samplePdf();
  const meta = readPhotoMeta(src);
  expect(meta.format).toBe("pdf");
  expect(meta.canStrip).toBe(true);
  expect(meta.fields.map((f) => f.tag)).toEqual(expect.arrayContaining(["Author", "Title", "Creator"]));
  expect(meta.gps?.lon).toBeCloseTo(-123.1, 5);
  const out = stripPhotoMeta(src);
  expect(latin1(out)).not.toContain("Ada");
  expect(latin1(out)).not.toContain("GPSLatitude");
  expect(latin1(out).startsWith("%PDF-")).toBe(true);
  const again = readPhotoMeta(out);
  expect(again.gps).toBeNull();
  expect(again.fields).toEqual([]);
});

test("encrypted, compressed and unstructured PDFs are not offered as cleaned", () => {
  const encrypted = samplePdf(" /Encrypt 9 0 R");
  expect(readPhotoMeta(encrypted).canStrip).toBe(false);
  expect(() => stripPhotoMeta(encrypted)).toThrow(UnsupportedImage);
  const compressed = samplePdf("", { filter: true });
  expect(readPhotoMeta(compressed).canStrip).toBe(false);
  expect(readPhotoMeta(compressed).fields.some((f) => f.value === "Ada Lovelace")).toBe(true);
  expect(() => stripPhotoMeta(text("%PDF-1.4\nnot a real pdf"))).toThrow(UnsupportedImage);
});

test("a simple HEIC Exif item is wiped in place and the rest of the file stays", () => {
  const { file, markerAt } = sampleHeic();
  const meta = readPhotoMeta(file);
  expect(meta.format).toBe("heic");
  expect(meta.canStrip).toBe(true);
  expect(meta.gps?.lat).toBeCloseTo(49.25, 5);
  const out = stripPhotoMeta(file);
  expect(latin1(out)).not.toContain("Acme");
  expect(latin1(out.slice(markerAt, markerAt + 9))).toBe("IMAGEDATA");
  expect(readPhotoMeta(out).gps).toBeNull();
});

test("a HEIC whose layout cannot be rewritten says so instead of pretending it is clean", () => {
  const src = concat([box("ftyp", text("heic\0\0\0\0heic")), text("not-a-box!!")]);
  const meta = readPhotoMeta(src);
  expect(meta.canStrip).toBe(false);
  expect(meta.limit).toBe("heic_layout");
  expect(() => stripPhotoMeta(src)).toThrow(UnsupportedImage);
});

test("BigTIFF and unknown bytes are refused", () => {
  const big = Uint8Array.from([0x49, 0x49, 43, 0, 0, 0, 0, 0]);
  expect(() => readPhotoMeta(big)).toThrow(UnsupportedImage);
  expect(() => readPhotoMeta(Uint8Array.from([1, 2, 3, 4]))).toThrow(UnsupportedImage);
});

function latin1(b: Uint8Array) {
  return new TextDecoder("latin1").decode(b);
}
function includes(hay: Uint8Array, needle: Uint8Array) {
  return latin1(hay).includes(latin1(needle));
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(text(type), 4);
  out.set(data, 8);
  return out;
}
function png(parts: Uint8Array[]) {
  return concat([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...parts]);
}
function webpChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(text(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}
function webp(parts: Uint8Array[]) {
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(text("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, body.length + 4, true);
  out.set(text("WEBP"), 8);
  out.set(body, 12);
  return out;
}
function box(type: string, content: Uint8Array, version?: number) {
  const payload = version === undefined ? content : concat([Uint8Array.from([version, 0, 0, 0]), content]);
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(text(type), 4);
  out.set(payload, 8);
  return out;
}

function sampleTiff(): { file: Uint8Array; pixels: Uint8Array } {
  const pixels = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
  const artist = text("SECRETLOC\0");
  const n = 12;
  const ifdAt = 8;
  const artistAt = ifdAt + 2 + n * 12 + 4;
  const gpsAt = artistAt + artist.length;
  const gpsIfd = 2 + 4 * 12 + 4;
  const ratAt = gpsAt + gpsIfd;
  const pixelAt = ratAt + 48;
  const file = new Uint8Array(pixelAt + pixels.length);
  const v = new DataView(file.buffer);
  file[0] = 0x49;
  file[1] = 0x49;
  v.setUint16(2, 42, true);
  v.setUint32(4, ifdAt, true);
  v.setUint16(ifdAt, n, true);
  const entries: [number, number, number, number][] = [
    [256, 4, 1, 2],
    [257, 4, 1, 2],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [274, 3, 1, 6],
    [277, 3, 1, 1],
    [278, 4, 1, 2],
    [273, 4, 1, pixelAt],
    [279, 4, 1, pixels.length],
    [0x013b, 2, artist.length, artistAt],
    [0x8825, 4, 1, gpsAt],
  ] satisfies [number, number, number, number][];
  entries.sort((a, b) => a[0] - b[0]);
  entries.forEach((e, i) => {
    const at = ifdAt + 2 + i * 12;
    v.setUint16(at, e[0], true);
    v.setUint16(at + 2, e[1], true);
    v.setUint32(at + 4, e[2], true);
    if (e[1] === 3) v.setUint16(at + 8, e[3], true);
    else v.setUint32(at + 8, e[3], true);
  });
  file.set(artist, artistAt);
  v.setUint16(gpsAt, 4, true);
  const ent = (i: number, tag: number, type: number, count: number, value: number) => {
    const at = gpsAt + 2 + i * 12;
    v.setUint16(at, tag, true);
    v.setUint16(at + 2, type, true);
    v.setUint32(at + 4, count, true);
    if (type === 2) v.setUint16(at + 8, value, true);
    else v.setUint32(at + 8, value, true);
  };
  ent(0, 1, 2, 2, 0x004e);
  ent(1, 2, 5, 3, ratAt);
  ent(2, 3, 2, 2, 0x0057);
  ent(3, 4, 5, 3, ratAt + 24);
  [49, 1, 15, 1, 0, 1, 123, 1, 6, 1, 0, 1].forEach((num, i) => v.setUint32(ratAt + i * 4, num, true));
  file.set(pixels, pixelAt);
  return { file, pixels };
}

function samplePdf(extraTrailer = "", opts?: { filter?: boolean }): Uint8Array {
  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  const add = (n: number, body: string) => {
    offsets[n] = chunks.join("").length;
    chunks.push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(2, "<< /Type /Pages /Count 0 /Kids [] >>");
  add(3, "<< /Author (Ada Lovelace) /Title (Home) /Creator (Frame) >>");
  const xml = "<exif:GPSLatitude>49,15.0N</exif:GPSLatitude><exif:GPSLongitude>123,6.0W</exif:GPSLongitude>";
  const filter = opts?.filter ? "/Filter /FlateDecode " : "";
  add(4, `<< /Type /Metadata /Subtype /XML ${filter}/Length ${xml.length} >>\nstream\n${xml}\nendstream`);
  const body = chunks.join("");
  const xrefAt = body.length;
  const line = (off: number, flag: "n" | "f") =>
    `${String(off).padStart(10, "0")} ${String(flag === "f" ? 65535 : 0).padStart(5, "0")} ${flag} \n`;
  let xref = "xref\n0 5\n" + line(0, "f");
  for (let i = 1; i <= 4; i++) xref += line(offsets[i], "n");
  const trailer = `trailer\n<< /Size 5 /Root 1 0 R /Info 3 0 R${extraTrailer} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return text(body + xref + trailer);
}

function sampleHeic(): { file: Uint8Array; markerAt: number } {
  const tiff = exifTiff(gpsJpeg());
  const payload = concat([Uint8Array.from([0, 0, 0, 6, 0, 0]), tiff]);
  const marker = text("IMAGEDATA");
  const ftyp = box("ftyp", text("heic\0\0\0\0heic"));
  const infeBody = new Uint8Array(9);
  new DataView(infeBody.buffer).setUint16(0, 1);
  infeBody.set(text("Exif"), 4);
  const iinf = box("iinf", concat([Uint8Array.from([0, 1]), box("infe", infeBody, 2)]), 0);
  const ilocFor = (offset: number) => {
    const content = new Uint8Array(18);
    content[0] = 0x44;
    const v = new DataView(content.buffer);
    v.setUint16(2, 1);
    v.setUint16(4, 1);
    v.setUint16(8, 1);
    v.setUint32(10, offset);
    v.setUint32(14, payload.length);
    return box("iloc", content, 0);
  };
  const metaLen = box("meta", concat([iinf, ilocFor(0)]), 0).length;
  const offset = ftyp.length + metaLen + 8;
  const meta = box("meta", concat([iinf, ilocFor(offset)]), 0);
  const file = concat([ftyp, meta, box("mdat", concat([payload, marker]))]);
  return { file, markerAt: offset + payload.length };
}

test("errors carry a code and an English sentence for it", () => {
  try {
    readPhotoMeta(Uint8Array.from([1, 2, 3, 4]));
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UnsupportedImage);
    expect((e as UnsupportedImage).code).toBe("format");
    expect((e as UnsupportedImage).message).toBe(LIMITS.format);
  }
  for (const sentence of Object.values(LIMITS)) expect(sentence).toMatch(/^[A-Z].*\.$/);
});
