// Pure formula evaluation for custom-field expressions like "{{Qty}} * {{Price}}".
// Only allowlisted functions and operators are interpreted, never JavaScript.
// References are raw values, including stored formula strings; no dependency evaluation.
// Malformed input, missing fields and non-finite results return the raw expression.
export type FormulaValue = string | number | boolean | null;

const MAX_REFS = 20;
const MAX_DEPTH = 8;

type Token =
  | { kind: "ref"; name: string }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "function"; name: string }
  | { kind: "comma" }
  | { kind: "op"; value: string }
  | { kind: "lp" }
  | { kind: "rp" };

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (char === "{") {
      if (expression[index + 1] !== "{") return null;
      const end = expression.indexOf("}}", index + 2);
      if (end < 0) return null;
      const name = expression.slice(index + 2, end);
      if (!name.trim() || /[{}]/.test(name)) return null;
      tokens.push({ kind: "ref", name: name.trim() });
      index = end + 2;
    } else if (char === '"') {
      let value = "";
      let closed = false;
      index++;
      while (index < expression.length) {
        const next = expression[index++];
        if (next !== '"') value += next;
        else if (expression[index] === '"') { value += '"'; index++; }
        else { closed = true; break; }
      }
      if (!closed) return null;
      tokens.push({ kind: "string", value });
    } else if (/[a-z]/i.test(char)) {
      const name = /^[a-z]+/i.exec(expression.slice(index))![0];
      if (!["SUM", "AVERAGE", "MIN", "MAX", "ROUND", "ABS", "IF", "CONCAT"].includes(name.toUpperCase())) return null;
      tokens.push({ kind: "function", name: name.toUpperCase() });
      index += name.length;
    } else if (char === ",") {
      tokens.push({ kind: "comma" });
      index++;
    } else if ("=<>!".includes(char)) {
      const match = /^(<>|!=|>=|<=|=|>|<)/.exec(expression.slice(index));
      if (!match) return null;
      tokens.push({ kind: "op", value: match[0] });
      index += match[0].length;
    } else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(expression[index + 1] || ""))) {
      const match = /^\d*\.?\d+/.exec(expression.slice(index));
      if (!match) return null;
      tokens.push({ kind: "number", value: Number(match[0]) });
      index += match[0].length;
    } else if ("+-*/%".includes(char)) {
      tokens.push({ kind: "op", value: char });
      index++;
    } else if (char === "(") {
      tokens.push({ kind: "lp" });
      index++;
    } else if (char === ")") {
      tokens.push({ kind: "rp" });
      index++;
    } else if (/\s/.test(char)) {
      index++;
    } else {
      return null;
    }
  }
  return tokens;
}

function coerce(value: FormulaValue, forString: boolean): string | number {
  if (forString) {
    if (value === null) return "";
    if (typeof value === "boolean") return value ? "true" : "false";
    return typeof value === "number" ? formatNumber(value) : value;
  }
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return value === "" ? Number.NaN : Number(value);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return String(value);
  const text = value.toFixed(6).replace(/\.?0+$/, "");
  return Number(text) === 0 ? "0" : text;
}

export function evaluateFormula(
  expression: string,
  values: Record<string, FormulaValue>,
): string {
  if (typeof expression !== "string" || expression.length > 200) return expression;
  const tokens = tokenize(expression.trimStart().replace(/^=/, ""));
  if (!tokens) return expression;
  const refs = tokens.filter((token): token is Extract<Token, { kind: "ref" }> => token.kind === "ref");
  if (refs.length > MAX_REFS || refs.some((token) => !Object.hasOwn(values, token.name))) return expression;
  let position = 0;
  let depth = 0;
  const peek = () => tokens[position];
  // Parse failures throw; a null reference value is a real operand that
  // coerces to 0 in numeric operations and "" in concatenation.
  const fail = (): never => {
    throw new RangeError("malformed");
  };
  const finite = (value: number): number => Number.isFinite(value) ? value : fail();
  const numeric = (value: FormulaValue): number => finite(Number(coerce(value, false)));
  const parsePrimary = (active: boolean): FormulaValue => {
    const token = peek();
    if (!token) return fail();
    position++;
    if (token.kind === "number") return finite(token.value);
    if (token.kind === "string") return token.value;
    if (token.kind === "ref") {
      if (!active) return null;
      const value = values[token.name];
      if (typeof value === "number") finite(value);
      return value;
    }
    if (token.kind === "op" && (token.value === "-" || token.value === "+")) {
      if (depth >= MAX_DEPTH) fail();
      depth++;
      const operand = parsePrimary(active);
      depth--;
      return active ? finite(numeric(operand) * (token.value === "-" ? -1 : 1)) : null;
    }
    if (token.kind === "lp" || token.kind === "function") {
      if (depth >= MAX_DEPTH) fail();
      depth++;
      if (token.kind === "function") {
        if (peek()?.kind !== "lp") return fail();
        position++;
      }
      const args: FormulaValue[] = [];
      if (peek()?.kind !== "rp") {
        do {
          if (args.length) position++;
          // Always parse both IF branches, but only execute the chosen one.
          const chosen = token.kind !== "function" || token.name !== "IF" || args.length === 0
            || (args.length === 1 ? Boolean(args[0]) : !Boolean(args[0]));
          args.push(parseComparison(active && chosen));
        } while (token.kind === "function" && peek()?.kind === "comma");
      }
      const next = peek();
      if (!next || next.kind !== "rp") return fail();
      position++;
      depth--;
      if (token.kind === "lp") return args.length === 1 ? args[0] : fail();
      const name = token.name;
      if (name === "IF" ? args.length !== 3 : name === "ROUND" ? args.length !== 2
        : name === "ABS" ? args.length !== 1 : args.length === 0) return fail();
      if (!active) return null;
      if (name === "IF") return args[0] ? args[1] : args[2];
      if (name === "CONCAT") return args.map((value) => coerce(value, true)).join("");
      const numbers = args.map(numeric);
      if (name === "ABS") return Math.abs(numbers[0]);
      if (name === "MIN") return Math.min(...numbers);
      if (name === "MAX") return Math.max(...numbers);
      if (name === "ROUND") {
        const [value, digits] = numbers;
        if (!Number.isInteger(digits) || Math.abs(digits) > 308) return fail();
        // Decimal shifting avoids binary scaling errors (e.g. ROUND(1.005, 2)).
        const shift = (number: number, places: number): number => {
          const [mantissa, exponent = "0"] = String(number).split("e");
          return finite(Number(`${mantissa}e${Number(exponent) + places}`));
        };
        return finite(Math.sign(value) * shift(Math.round(shift(Math.abs(value), digits)), -digits));
      }
      const sum = numbers.reduce((total, value) => finite(total + value), 0);
      return name === "AVERAGE" ? finite(sum / numbers.length) : sum;
    }
    return fail();
  };
  const parseProduct = (active: boolean): FormulaValue => {
    let left = parsePrimary(active);
    while (true) {
      const token = peek();
      if (!token || token.kind !== "op" || !["*", "/", "%"].includes(token.value)) return left;
      position++;
      const right = parsePrimary(active);
      if (!active) continue;
      const a = Number(coerce(left, false));
      const b = Number(coerce(right, false));
      if (!Number.isFinite(a) || !Number.isFinite(b)) fail();
      left = finite(token.value === "*" ? a * b : token.value === "/" ? a / b : a % b);
    }
  };
  const parseSum = (active: boolean): FormulaValue => {
    let left = parseProduct(active);
    while (true) {
      const token = peek();
      if (!token || token.kind !== "op" || (token.value !== "+" && token.value !== "-")) return left;
      position++;
      const right = parseProduct(active);
      if (!active) continue;
      // Concatenate when either operand is a string field value; otherwise
      // both sides coerce numerically with null becoming 0.
      if (typeof left === "string" || typeof right === "string") {
        if (token.value === "-") fail();
        left = (coerce(left, true) as string) + (coerce(right, true) as string);
      } else {
        const a = Number(coerce(left, false));
        const b = Number(coerce(right, false));
        if (!Number.isFinite(a) || !Number.isFinite(b)) fail();
        left = finite(token.value === "+" ? a + b : a - b);
      }
    }
  };
  const parseComparison = (active: boolean): FormulaValue => {
    let left = parseSum(active);
    while (true) {
      const token = peek();
      if (!token || token.kind !== "op" || !["=", "<>", "!=", ">", ">=", "<", "<="].includes(token.value)) return left;
      position++;
      const right = parseSum(active);
      if (!active) continue;
      const text = typeof left === "string" && typeof right === "string";
      const a = text ? String(left) : numeric(left);
      const b = text ? String(right) : numeric(right);
      left = token.value === "=" ? a === b : token.value === "<>" || token.value === "!=" ? a !== b
        : token.value === ">" ? a > b : token.value === ">=" ? a >= b : token.value === "<" ? a < b : a <= b;
    }
  };
  try {
    const result = parseComparison(true);
    if (position !== tokens.length) return expression;
    return typeof result === "number" ? formatNumber(result) : String(result);
  } catch {
    return expression;
  }
}
