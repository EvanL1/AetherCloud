export type StrictJsonFailureCode =
  | "DUPLICATE_JSON_KEY"
  | "FIELD_BOUND"
  | "JSON_INVALID_UNICODE"
  | "JSON_NON_FINITE_NUMBER"
  | "JSON_SYNTAX_ERROR"
  | "JSON_UNSAFE_NUMBER";

export class StrictJsonError extends SyntaxError {
  readonly code: StrictJsonFailureCode;
  readonly offset: number | undefined;

  constructor(code: StrictJsonFailureCode, message: string, offset?: number) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
    this.offset = offset;
  }
}

export interface StrictJsonBudgets {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringCodeUnits: number;
  readonly maxObjectMembers: number;
  readonly maxArrayItems: number;
  readonly maxNumberTokenLength: number;
}

export type StrictJsonBudgetOverrides = Partial<StrictJsonBudgets>;
export type StrictJsonInput = string | ArrayBuffer | ArrayBufferView;

export const INTEGRATION_ENVELOPE_JSON_BUDGETS: StrictJsonBudgets =
  Object.freeze({
    maxBytes: 4_194_304,
    maxDepth: 16,
    maxStringCodeUnits: 16_384,
    maxObjectMembers: 16,
    maxArrayItems: 65_536,
    maxNumberTokenLength: 128,
  });

function fail(code: StrictJsonFailureCode, message: string): never {
  throw new StrictJsonError(code, message);
}

function resolveBudgets(
  overrides: StrictJsonBudgetOverrides | undefined,
): StrictJsonBudgets {
  const rawOverrides: unknown = overrides;
  if (
    rawOverrides !== undefined &&
    (typeof rawOverrides !== "object" || rawOverrides === null)
  ) {
    throw new TypeError("strict JSON budgets must be an object");
  }
  const budgets: StrictJsonBudgets = {
    ...INTEGRATION_ENVELOPE_JSON_BUDGETS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(
        `strict JSON budget ${name} must be a positive safe integer`,
      );
    }
  }
  return Object.freeze(budgets);
}

function assertValidUtf16(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(
          "JSON_INVALID_UNICODE",
          "raw JSON contains an unpaired high surrogate",
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(
        "JSON_INVALID_UNICODE",
        "raw JSON contains an unpaired low surrogate",
      );
    }
  }
}

function assertUtf8ByteLength(text: string, maximum: number): void {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > maximum) {
      fail(
        "FIELD_BOUND",
        `raw JSON exceeds the ${String(maximum)} byte budget`,
      );
    }
  }
}

function decodeUtf8(input: Exclude<StrictJsonInput, string>, maximum: number) {
  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (bytes.byteLength > maximum) {
    fail("FIELD_BOUND", `raw JSON exceeds the ${String(maximum)} byte budget`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("JSON_INVALID_UNICODE", "raw JSON is not well-formed UTF-8");
  }
}

class JsonParser {
  readonly #text: string;
  readonly #budgets: StrictJsonBudgets;
  #index = 0;

  constructor(text: string, budgets: StrictJsonBudgets) {
    this.#text = text;
    this.#budgets = budgets;
  }

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) {
      this.#syntax("unexpected content after the JSON value");
    }
    return value;
  }

  #syntax(message: string): never {
    throw new StrictJsonError(
      "JSON_SYNTAX_ERROR",
      `${message} at offset ${String(this.#index)}`,
      this.#index,
    );
  }

  #skipWhitespace(): void {
    while (
      this.#text[this.#index] === " " ||
      this.#text[this.#index] === "\t" ||
      this.#text[this.#index] === "\n" ||
      this.#text[this.#index] === "\r"
    ) {
      this.#index += 1;
    }
  }

  #parseValue(depth: number): unknown {
    const character = this.#text[this.#index];
    switch (character) {
      case "{":
        return this.#parseObject(depth + 1);
      case "[":
        return this.#parseArray(depth + 1);
      case '"':
        return this.#parseString();
      case "t":
        return this.#parseKeyword("true", true);
      case "f":
        return this.#parseKeyword("false", false);
      case "n":
        return this.#parseKeyword("null", null);
      default:
        if (
          character === "-" ||
          (character !== undefined && character >= "0" && character <= "9")
        ) {
          return this.#parseNumber();
        }
        return this.#syntax("expected a JSON value");
    }
  }

  #parseKeyword(keyword: string, value: unknown): unknown {
    if (
      this.#text.slice(this.#index, this.#index + keyword.length) !== keyword
    ) {
      this.#syntax(`expected ${keyword}`);
    }
    this.#index += keyword.length;
    return value;
  }

  #parseObject(depth: number): Record<string, unknown> {
    if (depth > this.#budgets.maxDepth) {
      fail(
        "FIELD_BOUND",
        `raw JSON exceeds depth ${String(this.#budgets.maxDepth)}`,
      );
    }
    this.#index += 1;
    this.#skipWhitespace();
    const entries: [string, unknown][] = [];
    const keys = new Set<string>();

    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return {};
    }

    while (this.#index < this.#text.length) {
      if (entries.length >= this.#budgets.maxObjectMembers) {
        fail(
          "FIELD_BOUND",
          `raw JSON object exceeds ${String(this.#budgets.maxObjectMembers)} members`,
        );
      }
      if (this.#text[this.#index] !== '"') {
        this.#syntax("expected an object member name");
      }
      const key = this.#parseString();
      if (keys.has(key)) {
        fail("DUPLICATE_JSON_KEY", "raw JSON object repeats a member");
      }
      keys.add(key);

      this.#skipWhitespace();
      if (this.#text[this.#index] !== ":") {
        this.#syntax("expected ':' after an object member name");
      }
      this.#index += 1;
      this.#skipWhitespace();
      entries.push([key, this.#parseValue(depth)]);
      this.#skipWhitespace();

      const separator = this.#text[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return Object.fromEntries(entries);
      }
      if (separator !== ",") {
        this.#syntax("expected ',' or '}' in an object");
      }
      this.#index += 1;
      this.#skipWhitespace();
    }
    return this.#syntax("unterminated object");
  }

  #parseArray(depth: number): readonly unknown[] {
    if (depth > this.#budgets.maxDepth) {
      fail(
        "FIELD_BOUND",
        `raw JSON exceeds depth ${String(this.#budgets.maxDepth)}`,
      );
    }
    this.#index += 1;
    this.#skipWhitespace();
    const values: unknown[] = [];

    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return values;
    }

    while (this.#index < this.#text.length) {
      if (values.length >= this.#budgets.maxArrayItems) {
        fail(
          "FIELD_BOUND",
          `raw JSON array exceeds ${String(this.#budgets.maxArrayItems)} items`,
        );
      }
      values.push(this.#parseValue(depth));
      this.#skipWhitespace();

      const separator = this.#text[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return values;
      }
      if (separator !== ",") {
        this.#syntax("expected ',' or ']' in an array");
      }
      this.#index += 1;
      this.#skipWhitespace();
    }
    return this.#syntax("unterminated array");
  }

  #parseString(): string {
    this.#index += 1;
    let value = "";

    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index];
      if (character === undefined) {
        return this.#syntax("unterminated string");
      }
      if (character === '"') {
        this.#index += 1;
        return value;
      }
      if (character === "\\") {
        const escaped = this.#parseEscape();
        if (value.length + escaped.length > this.#budgets.maxStringCodeUnits) {
          fail(
            "FIELD_BOUND",
            `JSON string exceeds ${String(this.#budgets.maxStringCodeUnits)} code units`,
          );
        }
        value += escaped;
        continue;
      }

      const codeUnit = this.#text.charCodeAt(this.#index);
      if (codeUnit <= 0x1f) {
        this.#syntax("unescaped control character in a string");
      }
      if (value.length + 1 > this.#budgets.maxStringCodeUnits) {
        fail(
          "FIELD_BOUND",
          `JSON string exceeds ${String(this.#budgets.maxStringCodeUnits)} code units`,
        );
      }
      value += character;
      this.#index += 1;
    }
    return this.#syntax("unterminated string");
  }

  #parseEscape(): string {
    this.#index += 1;
    const escape = this.#text[this.#index];
    switch (escape) {
      case '"':
        this.#index += 1;
        return '"';
      case "/":
        this.#index += 1;
        return "/";
      case "\\":
        this.#index += 1;
        return "\\";
      case "b":
        this.#index += 1;
        return "\b";
      case "f":
        this.#index += 1;
        return "\f";
      case "n":
        this.#index += 1;
        return "\n";
      case "r":
        this.#index += 1;
        return "\r";
      case "t":
        this.#index += 1;
        return "\t";
      case "u":
        break;
      default:
        return this.#syntax("invalid JSON string escape");
    }

    const first = this.#parseHexEscape();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.#text.slice(this.#index, this.#index + 2) !== "\\u") {
        fail(
          "JSON_INVALID_UNICODE",
          "JSON string escape contains an unpaired high surrogate",
        );
      }
      this.#index += 1;
      const second = this.#parseHexEscape();
      if (!(second >= 0xdc00 && second <= 0xdfff)) {
        fail(
          "JSON_INVALID_UNICODE",
          "JSON string escape contains an unpaired high surrogate",
        );
      }
      return String.fromCodePoint(
        0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
      );
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      fail(
        "JSON_INVALID_UNICODE",
        "JSON string escape contains an unpaired low surrogate",
      );
    }
    return String.fromCharCode(first);
  }

  #parseHexEscape(): number {
    if (this.#text[this.#index] !== "u") {
      this.#syntax("expected a Unicode escape");
    }
    const hexadecimal = this.#text.slice(this.#index + 1, this.#index + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hexadecimal)) {
      this.#syntax("invalid Unicode escape");
    }
    this.#index += 5;
    return Number.parseInt(hexadecimal, 16);
  }

  #parseNumber(): number {
    const start = this.#index;
    if (this.#text[this.#index] === "-") {
      this.#index += 1;
    }

    if (this.#text[this.#index] === "0") {
      this.#index += 1;
      if (this.#isDigit(this.#text[this.#index])) {
        this.#syntax("leading zero in a JSON number");
      }
    } else if (this.#isNonzeroDigit(this.#text[this.#index])) {
      while (this.#isDigit(this.#text[this.#index])) {
        this.#index += 1;
      }
    } else {
      this.#syntax("invalid JSON number integer part");
    }

    let hasFraction = false;
    let fractionContainsNonzero = false;
    let hasExponent = false;
    if (this.#text[this.#index] === ".") {
      hasFraction = true;
      this.#index += 1;
      if (!this.#isDigit(this.#text[this.#index])) {
        this.#syntax("missing JSON number fraction digits");
      }
      while (this.#isDigit(this.#text[this.#index])) {
        if (this.#text[this.#index] !== "0") {
          fractionContainsNonzero = true;
        }
        this.#index += 1;
      }
    }

    if (this.#text[this.#index] === "e" || this.#text[this.#index] === "E") {
      hasExponent = true;
      this.#index += 1;
      if (this.#text[this.#index] === "+" || this.#text[this.#index] === "-") {
        this.#index += 1;
      }
      if (!this.#isDigit(this.#text[this.#index])) {
        this.#syntax("missing JSON number exponent digits");
      }
      while (this.#isDigit(this.#text[this.#index])) {
        this.#index += 1;
      }
    }

    const tokenLength = this.#index - start;
    if (tokenLength > this.#budgets.maxNumberTokenLength) {
      fail(
        "FIELD_BOUND",
        `JSON number exceeds ${String(this.#budgets.maxNumberTokenLength)} characters`,
      );
    }
    const token = this.#text.slice(start, this.#index);
    const value = Number(token);
    const sourceHasIntegerSemantics =
      (!hasFraction || !fractionContainsNonzero) &&
      (!hasExponent || Number.isInteger(value));
    const unsafeFiniteInteger =
      Number.isInteger(value) && !Number.isSafeInteger(value);
    const canonicalKeepsFraction = JSON.stringify(value).includes(".");
    if (
      (sourceHasIntegerSemantics && !Number.isSafeInteger(value)) ||
      (unsafeFiniteInteger && !canonicalKeepsFraction)
    ) {
      fail(
        "JSON_UNSAFE_NUMBER",
        "JSON integer number is outside the interoperable safe range",
      );
    }
    if (!Number.isFinite(value)) {
      fail("JSON_NON_FINITE_NUMBER", "JSON number has a non-finite result");
    }
    return value;
  }

  #isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }

  #isNonzeroDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "1" && character <= "9";
  }
}

export function decodeStrictJson(
  input: StrictJsonInput,
  budgetOverrides?: StrictJsonBudgetOverrides,
): unknown {
  const budgets = resolveBudgets(budgetOverrides);
  let text: string;
  if (typeof input === "string") {
    assertValidUtf16(input);
    assertUtf8ByteLength(input, budgets.maxBytes);
    text = input;
  } else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    text = decodeUtf8(input, budgets.maxBytes);
  } else {
    throw new TypeError(
      "strict JSON input must be a string, ArrayBuffer, or byte view",
    );
  }
  assertValidUtf16(text);
  return new JsonParser(text, budgets).parse();
}
