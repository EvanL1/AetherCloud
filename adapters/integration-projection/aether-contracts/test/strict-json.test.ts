import { describe, expect, it } from "vitest";

import {
  INTEGRATION_ENVELOPE_JSON_BUDGETS,
  StrictJsonError,
  decodeStrictJson,
  type StrictJsonBudgetOverrides,
  type StrictJsonInput,
} from "../src/index.js";

function expectFailure(input: string | Uint8Array, code: string): void {
  let captured: unknown;
  try {
    decodeStrictJson(input);
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(SyntaxError);
  expect((captured as { readonly code?: unknown }).code).toBe(code);
}

describe("strict integration JSON decoder", () => {
  it("accepts UTF-8, safe integers, and finite floating-point values", () => {
    const source = new TextEncoder().encode(
      '{"message":"Aether 🌍","safe":9007199254740991,"small":1e-100,"large":1.7976931348623157e308}',
    );

    expect(decodeStrictJson(source)).toEqual({
      message: "Aether 🌍",
      safe: Number.MAX_SAFE_INTEGER,
      small: 1e-100,
      large: Number.MAX_VALUE,
    });
  });

  it("accepts every JSON value form, string escape, and UTF-8 width", () => {
    const source =
      '{"empty_object":{},"empty_array":[],"truth":true,"falsehood":false,"nil":null,"escaped":"\\"\\\\\\/\\b\\f\\n\\r\\t","pair":"\\ud83c\\udf0d","text":"é中🌍","negative":-1.25e+2}';
    const bytes = new TextEncoder().encode(source);
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );

    expect(decodeStrictJson(arrayBuffer)).toEqual({
      empty_object: {},
      empty_array: [],
      truth: true,
      falsehood: false,
      nil: null,
      escaped: '"\\/\b\f\n\r\t',
      pair: "🌍",
      text: "é中🌍",
      negative: -125,
    });
    expect(decodeStrictJson('{"left":{"id":1},"right":{"id":2}}')).toEqual({
      left: { id: 1 },
      right: { id: 2 },
    });
  });

  it("rejects duplicate keys after escape decoding", () => {
    expectFailure(
      '{"integration_id":"first","integration_id":"second"}',
      "DUPLICATE_JSON_KEY",
    );
    expectFailure(
      '{"integration_id":"first","integration\\u005fid":"second"}',
      "DUPLICATE_JSON_KEY",
    );
    expectFailure(
      '{"outer":{"point_key":"first","point_key":"second"}}',
      "DUPLICATE_JSON_KEY",
    );
  });

  it("rejects malformed UTF-8 and unpaired Unicode surrogates", () => {
    expectFailure(
      Uint8Array.from([
        0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
      ]),
      "JSON_INVALID_UNICODE",
    );
    expectFailure('{"value":"\\ud800"}', "JSON_INVALID_UNICODE");
    expectFailure('{"value":"\\udc00"}', "JSON_INVALID_UNICODE");
    expectFailure('{"value":"' + "\ud800" + '"}', "JSON_INVALID_UNICODE");
  });

  it("rejects unsafe or non-finite JSON number tokens", () => {
    for (const source of [
      '{"value":9007199254740992}',
      '{"value":-9007199254740992}',
      '{"value":9007199254740993e0}',
      '{"value":9007199254740993.0}',
      '{"value":1e100}',
      '{"value":1.5e20}',
    ]) {
      expectFailure(source, "JSON_UNSAFE_NUMBER");
    }
    expectFailure('{"value":1e400}', "JSON_NON_FINITE_NUMBER");
  });

  it("rejects malformed syntax with a stable offset", () => {
    for (const source of [
      "",
      "{",
      "{1:2}",
      '{"value" 1}',
      '{"value":1 "other":2}',
      '{"value":1,}',
      '["value" "other"]',
      '["value"',
      '"unterminated',
      '"\\x"',
      '"\\u12xz"',
      "tru",
      "-",
      "1.",
      "1e",
      '{"value":01}',
      '"line\nbreak"',
    ]) {
      let captured: unknown;
      try {
        decodeStrictJson(source);
      } catch (error: unknown) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(StrictJsonError);
      expect(captured).toMatchObject({ code: "JSON_SYNTAX_ERROR" });
      const offset = (captured as { readonly offset?: unknown }).offset;
      expect(typeof offset).toBe("number");
      expect(Number.isSafeInteger(offset)).toBe(true);
    }
  });

  it("enforces byte, nesting, string, member, collection, and number budgets", () => {
    expectFailure(
      new Uint8Array(INTEGRATION_ENVELOPE_JSON_BUDGETS.maxBytes + 1),
      "FIELD_BOUND",
    );
    expectFailure(
      `${"[".repeat(INTEGRATION_ENVELOPE_JSON_BUDGETS.maxDepth + 1)}null${"]".repeat(INTEGRATION_ENVELOPE_JSON_BUDGETS.maxDepth + 1)}`,
      "FIELD_BOUND",
    );
    for (const operation of [
      () => decodeStrictJson('{"key":"four"}', { maxStringCodeUnits: 3 }),
      () => decodeStrictJson('{"a":1,"b":2}', { maxObjectMembers: 1 }),
      () => decodeStrictJson("[1,2]", { maxArrayItems: 1 }),
      () => decodeStrictJson("1234", { maxNumberTokenLength: 3 }),
    ]) {
      let captured: unknown;
      try {
        operation();
      } catch (error: unknown) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(StrictJsonError);
      expect((captured as { readonly code?: unknown }).code).toBe(
        "FIELD_BOUND",
      );
    }
  });

  it("validates budget overrides before consuming untrusted input", () => {
    expect(() => decodeStrictJson("{}", { maxDepth: 0 })).toThrow(TypeError);
    expect(() =>
      decodeStrictJson("{}", {
        maxBytes: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(TypeError);
    expect(new StrictJsonError("FIELD_BOUND", "bounded")).toMatchObject({
      name: "StrictJsonError",
      code: "FIELD_BOUND",
    });
    expect(() =>
      decodeStrictJson("{}", null as unknown as StrictJsonBudgetOverrides),
    ).toThrow(TypeError);
    expect(() => decodeStrictJson(42 as unknown as StrictJsonInput)).toThrow(
      TypeError,
    );
  });

  it("rejects malformed escaped surrogate pairs", () => {
    expectFailure('"\\ud800x"', "JSON_INVALID_UNICODE");
    expectFailure('"\\ud800\\u0000"', "JSON_INVALID_UNICODE");
  });
});
