/**
 * Byte length of a string once encoded as UTF-8 — what the socket actually
 * puts on the wire, as opposed to `String.prototype.length`, which counts
 * UTF-16 code units and undercounts by up to 3x for non-ASCII text.
 *
 * The difference is load-bearing here: the same number is the send queue's
 * byte budget, `stats().sentBytes`, and `send()`'s return value, and the queue
 * shares that budget with binary frames that report true byte lengths. Mixing
 * the two units would let a queue of Japanese text hold three times the bytes
 * its bound allows.
 *
 * Counts rather than encodes, because this runs on every message of a 10 Hz
 * stream and `TextEncoder.encode` would allocate a throwaway copy of each one.
 * Matches `TextEncoder` exactly, including lone surrogates, which it replaces
 * with U+FFFD (3 bytes).
 */
export const utf8ByteLength = (s: string): number => {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a byte length of 4 only if a low surrogate follows.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3; // lone surrogate → U+FFFD
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};
