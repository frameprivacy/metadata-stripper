/** A tiny JPEG with EXIF (Make "Acme", orientation 6, GPS 49.25 N 123.1 W) and a comment. Not a viewable image. */
export function gpsJpeg(): Uint8Array {
  // TIFF (II): IFD0 { Make "Acme", Orientation 6, GPS ptr } ; GPS { N 49°15'0", W 123°6'0" }
  const b: number[] = [];
  const u16 = (v: number) => b.push(v & 0xff, v >> 8);
  const u32 = (v: number) => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
  b.push(0x49, 0x49, 0x2a, 0);
  u32(8);
  u16(3);
  u16(0x010f);
  u16(2);
  u32(5);
  u32(50); // Make → offset 50
  u16(0x0112);
  u16(3);
  u32(1);
  u16(6);
  u16(0);
  u16(0x8825);
  u16(4);
  u32(1);
  u32(56); // GPS IFD at 56
  u32(0);
  while (b.length < 50) b.push(0);
  b.push(...[..."Acme"].map((c) => c.charCodeAt(0)), 0, 0); // 50..55
  // GPS IFD @56: 4 entries
  u16(4);
  u16(1);
  u16(2);
  u32(2);
  b.push(0x4e, 0, 0, 0); // 'N'
  u16(2);
  u16(5);
  u32(3);
  u32(110);
  u16(3);
  u16(2);
  u32(2);
  b.push(0x57, 0, 0, 0); // 'W'
  u16(4);
  u16(5);
  u32(3);
  u32(134);
  u32(0);
  while (b.length < 110) b.push(0);
  for (const [n, d] of [
    [49, 1],
    [15, 1],
    [0, 1],
    [123, 1],
    [6, 1],
    [0, 1],
  ]) {
    u32(n);
    u32(d);
  }
  const exif = [..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat(b);
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const com = [0xff, 0xfe, 0, 7, ...[..."hello"].map((c) => c.charCodeAt(0))];
  const sos = [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...app1, ...com, ...sos]);
}
