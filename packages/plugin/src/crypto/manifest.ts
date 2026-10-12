// The plaintext structure encrypted inside a "file-content"/"attachment"
// envelope. See docs/protocol-spec.md §3. Encoded as a small binary frame
// rather than JSON so binary attachment content isn't base64-inflated.
export interface FileManifest {
  formatVersion: number;
  fileId: string;
  logicalPath: string;
  mimeType?: string;
  content: Uint8Array;
}

const MANIFEST_FORMAT_VERSION = 1;

function writeString(parts: Uint8Array[], value: string) {
  const bytes = new TextEncoder().encode(value);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, bytes.byteLength, false);
  parts.push(header, bytes);
}

function readString(view: DataView, bytes: Uint8Array, offset: { pos: number }): string {
  const len = view.getUint32(offset.pos, false);
  offset.pos += 4;
  const str = new TextDecoder().decode(bytes.subarray(offset.pos, offset.pos + len));
  offset.pos += len;
  return str;
}

export function encodeManifest(manifest: Omit<FileManifest, "formatVersion">): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([MANIFEST_FORMAT_VERSION])];
  writeString(parts, manifest.fileId);
  writeString(parts, manifest.logicalPath);
  writeString(parts, manifest.mimeType ?? "");
  const contentLenHeader = new Uint8Array(4);
  new DataView(contentLenHeader.buffer).setUint32(0, manifest.content.byteLength, false);
  parts.push(contentLenHeader, manifest.content);

  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

export function decodeManifest(bytes: Uint8Array): FileManifest {
  const formatVersion = bytes[0]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = { pos: 1 };
  const fileId = readString(view, bytes, offset);
  const logicalPath = readString(view, bytes, offset);
  const mimeType = readString(view, bytes, offset);
  const contentLen = view.getUint32(offset.pos, false);
  offset.pos += 4;
  const content = bytes.slice(offset.pos, offset.pos + contentLen);

  return { formatVersion, fileId, logicalPath, mimeType: mimeType || undefined, content };
}
