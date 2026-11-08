import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeBase64ToBinary,
  decodeUtf8,
  installTextPolyfills,
  Utf8TextDecoder,
} from "./text-polyfill.ts";

function outcome(f: () => string): string {
  try {
    return f();
  } catch {
    return "THROW";
  }
}

describe("decodeBase64ToBinary", () => {
  it("matches atob on valid and invalid input", () => {
    const cases = [
      "",
      "QQ==",
      "QQ",
      "QUI=",
      "QUJD",
      " Q Q = = ",
      "PHN2Zz48L3N2Zz4=",
      btoa("ÿ\u0000\u0080"),
      "QR==",
      "Q",
      "QQ=Q",
      "Q$==",
      "QQ===",
      "=QQQ",
      "QQ=",
      "QUJDQ=",
      "QUJDQQ=",
      "QUJDQ",
      "QU=I",
    ];
    for (const s of cases) {
      expect(
        outcome(() => decodeBase64ToBinary(s)),
        JSON.stringify(s),
      ).toBe(outcome(() => atob(s)));
    }
  });
});

describe("decodeUtf8", () => {
  const cases = [
    [],
    [0x3c, 0x73, 0x76, 0x67, 0x3e],
    [0xef, 0xbb, 0xbf, 0x41],
    [0xc3, 0xa9],
    [0xe2, 0x82, 0xac],
    [0xf0, 0x9f, 0x8c, 0x8a],
    [0xc0, 0x80],
    [0xed, 0xa0, 0x80],
    [0xe2, 0x82],
    [0xe2, 0x82, 0x41],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf0, 0x80, 0x80],
    [0x80],
    [0xff, 0xfe],
    [0x41, 0xef, 0xbb, 0xbf],
  ];

  it("matches the platform decoder, fatal and not, with and without the BOM", () => {
    for (const c of cases) {
      const bytes = Uint8Array.from(c);
      for (const fatal of [false, true]) {
        for (const ignoreBOM of [false, true]) {
          const native = new TextDecoder("utf-8", { fatal, ignoreBOM });
          expect(
            outcome(() => decodeUtf8(bytes, fatal, ignoreBOM)),
            JSON.stringify(c),
          ).toBe(outcome(() => native.decode(bytes)));
        }
      }
    }
  });

  it("matches the platform decoder on random bytes", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const native = new TextDecoder();
    for (let n = 0; n < 2000; n++) {
      const bytes = Uint8Array.from({ length: next() % 12 }, () =>
        next() % 3 === 0 ? 0x80 + (next() % 0x80) : next() % 256,
      );
      expect(decodeUtf8(bytes)).toBe(native.decode(bytes));
    }
  });
});

describe("Utf8TextDecoder", () => {
  it("takes the default and the utf-8 labels, and views of a buffer", () => {
    expect(new Utf8TextDecoder().decode(Uint8Array.of(0x41, 0xff))).toBe("A�");
    expect(new Utf8TextDecoder("UTF8").decode(new Uint8Array([0x7a]).buffer)).toBe("z");
    const view = new DataView(Uint8Array.of(0x00, 0x42, 0x43).buffer, 1);
    expect(new Utf8TextDecoder().decode(view)).toBe("BC");
    expect(() => new Utf8TextDecoder("latin1")).toThrow(RangeError);
  });
});

describe("installTextPolyfills", () => {
  it("fills what is missing and keeps a platform version that works", () => {
    const empty: Record<string, unknown> = {};
    installTextPolyfills(empty);
    expect(empty.atob).toBe(decodeBase64ToBinary);
    expect(empty.TextDecoder).toBe(Utf8TextDecoder);
    const present: Record<string, unknown> = { atob, TextDecoder };
    installTextPolyfills(present);
    expect(present.atob).toBe(atob);
    expect(present.TextDecoder).toBe(TextDecoder);
  });

  it("replaces a version that ignores fatal, refuses options, or accepts bad base64", () => {
    class Lenient {
      decode(b: Uint8Array) {
        return new TextDecoder().decode(b);
      }
    }
    class NoFatal {
      constructor(_l?: string, o?: { fatal?: boolean }) {
        if (o?.fatal) throw new RangeError("fatal unsupported");
      }
      decode(b: Uint8Array) {
        return new TextDecoder().decode(b);
      }
    }
    const loose = (s: string) => Buffer.from(s, "base64").toString("latin1");
    for (const Decoder of [Lenient, NoFatal]) {
      const target: Record<string, unknown> = { atob: loose, TextDecoder: Decoder };
      installTextPolyfills(target);
      expect(target.TextDecoder).toBe(Utf8TextDecoder);
      expect(target.atob).toBe(decodeBase64ToBinary);
    }
  });
});

describe("the brand contract's logo check on the polyfills alone", () => {
  it("accepts both synthetic tenants' logos, and still refuses a bad one", async () => {
    const { logoProblem } = await import("@tidegrid/contracts");
    const logos = ["demo-harbor", "demo-reef"].map((slug) => {
      const svg = readFileSync(
        new URL(`../../../config/tenants/${slug}/logo.svg`, import.meta.url),
      );
      return `data:image/svg+xml;base64,${svg.toString("base64")}`;
    });
    const bad = `data:image/svg+xml;base64,${Buffer.from([0x3c, 0xff, 0x3e]).toString("base64")}`;
    const g = globalThis as Record<string, unknown>;
    const saved = { atob: g.atob, TextDecoder: g.TextDecoder };
    try {
      delete g.atob;
      delete g.TextDecoder;
      installTextPolyfills();
      expect(g.TextDecoder).toBe(Utf8TextDecoder);
      for (const src of logos) expect(logoProblem(src)).toBeNull();
      expect(logoProblem(bad)).toBe("the SVG is not valid UTF-8");
    } finally {
      g.atob = saved.atob;
      g.TextDecoder = saved.TextDecoder;
    }
  });
});
