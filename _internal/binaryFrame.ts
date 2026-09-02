// Binary frame codec — the client half of the pigeon-message v1 binary format.
//
//   | ver(1B) | hdrLen(2B, BE) | header (UTF-8 JSON, hdrLen B) | payload |
//
// `pigeon-room` carries the server-side twin of this file (`lib/util.ts`); the
// two must stay byte-compatible. The spec itself lives in
// `@circuitlab/pigeon-message`, which owns the constants and the header type
// but deliberately ships no codec — encoding is each implementation's job.

import {
  BINARY_FRAME_VERSION,
  MAX_HEADER_BYTES,
} from "@circuitlab/pigeon-message";
import type { BinaryFrameHeader, ParsedBinaryFrame } from "./../types.ts";

export { BINARY_FRAME_VERSION, MAX_HEADER_BYTES };

/**
 * Reads a binary frame off the wire. Throws when the buffer is not a
 * well-formed frame — the caller decides whether that is worth logging.
 *
 * The returned `payload` is a view onto `buf`, not a copy: reading it is free,
 * but holding it holds the whole frame alive.
 */
export const parseBinaryFrame = (buf: ArrayBuffer): ParsedBinaryFrame => {
  if (buf.byteLength < 3) {
    throw new Error("binary frame too short");
  }
  const view = new DataView(buf);
  const ver = view.getUint8(0);
  const hdrLen = view.getUint16(1, false);
  if (3 + hdrLen > buf.byteLength) {
    throw new Error("binary frame header length exceeds buffer");
  }
  const headerBytes = new Uint8Array(buf, 3, hdrLen);
  const header = JSON.parse(
    new TextDecoder().decode(headerBytes),
  ) as BinaryFrameHeader;
  if (typeof header?.type !== "string") {
    throw new Error("binary frame header has no `type`");
  }
  const payload = new Uint8Array(buf, 3 + hdrLen);
  return { ver, header, payload };
};

/**
 * Builds a binary frame for sending. `from` / `address` / `timestamp` are
 * omitted deliberately: the room stamps them authoritatively on relay, so a
 * client that sets them only wastes header bytes.
 */
export const buildBinaryFrame = (
  header: BinaryFrameHeader,
  payload: Uint8Array,
  version: number = BINARY_FRAME_VERSION,
): ArrayBuffer => {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error(
      `Pigeon: binary frame header too large: ${headerBytes.length} > ${MAX_HEADER_BYTES} bytes. ` +
        `The header carries \`type\`, \`to\`, \`body\` and \`payloadMeta\` — move bulk data into the payload.`,
    );
  }
  const totalLen = 3 + headerBytes.length + payload.byteLength;
  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, version);
  dv.setUint16(1, headerBytes.length, false);
  out.set(headerBytes, 3);
  out.set(payload, 3 + headerBytes.length);
  return out.buffer;
};
