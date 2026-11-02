# metadata-stripper

[![CI](https://github.com/frameprivacy/metadata-stripper/actions/workflows/ci.yml/badge.svg)](https://github.com/frameprivacy/metadata-stripper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**See and remove the metadata hiding in photos and documents, without re-encoding them.**

Photos and files often carry more than you meant to share: the GPS spot where a picture was taken, the camera's
serial number, the author of a PDF, editing history in XMP. `metadata-stripper` reads that metadata so you can show it,
and writes a clean copy with it removed. It works on bytes in memory, in a browser or in Node, with zero dependencies.
Nothing is uploaded and the picture data is copied as-is, never re-encoded.

This is the metadata cleaner behind the free toolkit in [Frame](https://frameprivacy.com), with the app-specific parts
taken out.

## Install

```sh
npm install github:frameprivacy/metadata-stripper
```

## Usage

```ts
import { readPhotoMeta, stripPhotoMeta, UnsupportedImage, LIMITS } from "metadata-stripper";

const bytes = new Uint8Array(await file.arrayBuffer());

try {
  const meta = readPhotoMeta(bytes);
  // meta.format    "jpeg" | "png" | "webp" | "tiff" | "pdf" | "heic"
  // meta.fields    [{ kind: "location", tag: "GPS", value: "49.25000, -123.10000" }, ...]
  // meta.gps       { lat, lon } or null
  // meta.canStrip  false when a clean copy can't be made safely; meta.limit says why

  if (meta.canStrip) {
    const clean = stripPhotoMeta(bytes); // a new Uint8Array, same format
  } else if (meta.limit) {
    console.log(LIMITS[meta.limit]);
  }
} catch (e) {
  if (e instanceof UnsupportedImage)
    console.log(e.code, e.message); // e.g. "format", "damaged"
  else throw e;
}
```

## What gets removed

| Format | Removed                                                                                                            | Kept                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| JPEG   | EXIF, XMP, IPTC, comments, Multi-Picture Format and other non-ICC APP2 blocks, bytes after the end-of-image marker | Image data, ICC profile, Adobe color block, orientation |
| PNG    | `eXIf`, `tEXt`/`zTXt`/`iTXt`, `tIME`, content credentials (`caBX`)                                                 | Image data and color chunks                             |
| WebP   | EXIF and XMP chunks (and their VP8X flags)                                                                         | Image data, ICC profile                                 |
| TIFF   | Every tag a decoder doesn't need, including GPS, artist and camera                                                 | Image strips (copied as-is), orientation, ICC profile   |
| PDF    | Uncompressed document info (author, title, producer...) and XMP, blanked in place                                  | Everything else; byte offsets stay valid                |
| HEIC   | Exif and XMP item bytes, zeroed in place                                                                           | Everything else                                         |

## What it won't do

It refuses rather than guessing. When a clean copy can't be made safely, `readPhotoMeta` sets `canStrip: false` with
a `limit` code, and `stripPhotoMeta` throws `UnsupportedImage` with that code:

| Code             | When                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| `format`         | Not a JPEG, PNG, WebP, TIFF, PDF or HEIC                                      |
| `damaged`        | Truncated or inconsistent structure                                           |
| `tiff_unsafe`    | BigTIFF, or a compression the rebuild can't copy without changing the picture |
| `pdf_encrypted`  | Encrypted PDF                                                                 |
| `pdf_compressed` | Metadata in object streams or compressed streams                              |
| `pdf_structure`  | A cross-reference layout that can't be followed safely                        |
| `heic_layout`    | Exif or XMP stored in a layout other than a simple file offset                |

`LIMITS[code]` gives a plain English sentence for each code. For the PDF and HEIC cases, a common workaround is to
print to a new PDF or export the photo as JPEG, then clean that copy.

Removing metadata from a file doesn't remove what's visible in it. Faces, street signs, screens and reflections can
still identify a place or a person.

## Development

```sh
npm ci
npm test            # vitest
npm run coverage
npm run lint
npm run typecheck
npm run format:check
```

## License

[MIT](LICENSE)
