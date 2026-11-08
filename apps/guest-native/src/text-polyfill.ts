/**
 * The brand contract checks a logo with `atob` and a fatal UTF-8
 * `TextDecoder`, as browsers provide them, and Expo's fetch decodes text with
 * a default `TextDecoder`. Hermes may lack either, or ship one that differs
 * from the web platform, depending on the React Native version. The app
 * therefore tests what the engine does at start and installs these
 * spec-following versions only where the engine's are missing or wrong.
 */

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The WHATWG forgiving-base64 decode behind `atob`. Throws where `atob` throws. */
export function decodeBase64ToBinary(input: string): string {
  let data = String(input).replace(/[\t\n\f\r ]/g, "");
  if (data.length % 4 === 0) data = data.replace(/={1,2}$/, "");
  if (data.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(data)) {
    throw new Error("InvalidCharacterError: the string is not correctly encoded");
  }
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of data) {
    buffer = ((buffer << 6) | alphabet.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * The WHATWG Encoding standard's UTF-8 decoder. Malformed input becomes
 * U+FFFD per maximal subpart, or throws when `fatal`. A leading BOM is
 * dropped unless `ignoreBOM`.
 */
export function decodeUtf8(bytes: Uint8Array, fatal = false, ignoreBOM = false): string {
  const parts: number[] = [];
  let out = "";
  const flush = () => {
    out += String.fromCodePoint(...parts);
    parts.length = 0;
  };
  const emit = (cp: number) => {
    parts.push(cp);
    if (parts.length >= 4096) flush();
  };
  const error = () => {
    if (fatal) throw new TypeError("The encoded data was not valid utf-8");
    emit(0xfffd);
  };
  let codePoint = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i] as number;
    if (needed === 0) {
      i += 1;
      if (byte <= 0x7f) emit(byte);
      else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        codePoint = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        needed = 2;
        codePoint = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        codePoint = byte & 0x07;
      } else error();
      continue;
    }
    if (byte < lower || byte > upper) {
      // Reset and process this byte again as the start of a new sequence.
      codePoint = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      error();
      continue;
    }
    i += 1;
    lower = 0x80;
    upper = 0xbf;
    codePoint = (codePoint << 6) | (byte & 0x3f);
    seen += 1;
    if (seen === needed) {
      emit(codePoint);
      codePoint = 0;
      needed = 0;
      seen = 0;
    }
  }
  if (needed !== 0) error();
  flush();
  if (!ignoreBOM && out.charCodeAt(0) === 0xfeff) return out.slice(1);
  return out;
}

const utf8Labels = new Set([
  "unicode-1-1-utf-8",
  "unicode11utf8",
  "unicode20utf8",
  "utf-8",
  "utf8",
  "x-unicode20utf8",
]);

/** A UTF-8-only `TextDecoder`. Any other label throws, as an unsupported one does. */
export class Utf8TextDecoder {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!utf8Labels.has(String(label).trim().toLowerCase())) {
      throw new RangeError(`The encoding label provided ('${label}') is not supported here`);
    }
    this.fatal = Boolean(options.fatal);
    this.ignoreBOM = Boolean(options.ignoreBOM);
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return "";
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return decodeUtf8(bytes, this.fatal, this.ignoreBOM);
  }
}

/** True when the engine's `atob` follows the web platform on the cases the app relies on. */
function atobWorks(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  try {
    if (fn("QUI=") !== "AB" || fn(" Q Q = = ") !== "A") return false;
  } catch {
    return false;
  }
  for (const bad of ["QQ=", "Q", "Q$==", "QQ==="]) {
    try {
      fn(bad);
      return false;
    } catch {
      // expected
    }
  }
  return true;
}

/** True when the engine's `TextDecoder` follows the web platform for UTF-8, fatal or not. */
function textDecoderWorks(Ctor: unknown): boolean {
  if (typeof Ctor !== "function") return false;
  try {
    const D = Ctor as typeof TextDecoder;
    const bad = Uint8Array.of(0x41, 0xff, 0xe2, 0x82);
    if (new D().decode(bad) !== "A��") return false;
    if (new D("utf8").decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41)) !== "A") return false;
    if (new D("utf-8", { fatal: true }).decode(Uint8Array.of(0xc3, 0xa9)) !== "é") return false;
    try {
      new D("utf-8", { fatal: true }).decode(bad);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

export function installTextPolyfills(target: Record<string, unknown> = globalThis as never): void {
  if (!atobWorks(target.atob)) target.atob = decodeBase64ToBinary;
  if (!textDecoderWorks(target.TextDecoder)) target.TextDecoder = Utf8TextDecoder;
}
