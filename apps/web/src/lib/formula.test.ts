import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFormula } from "./formula.js";

const values = { Qty: 3, Price: 2.5, Name: "Widget", Flag: true, Empty: null };

test("arithmetic respects precedence and parentheses", () => {
  assert.equal(evaluateFormula("{{Qty}} * {{Price}} + 1", values), "8.5");
  assert.equal(evaluateFormula("({{Qty}} + 2) * {{Price}}", values), "12.5");
  assert.equal(evaluateFormula("10 - 2 - 3", values), "5");
  assert.equal(evaluateFormula("10 % 3", values), "1");
  assert.equal(evaluateFormula("-{{Qty}} + 1", values), "-2");
});

test("string concatenation when either operand is a string", () => {
  assert.equal(evaluateFormula("{{Name}} + {{Qty}}", values), "Widget3");
  assert.equal(evaluateFormula("{{Qty}} + {{Name}}", values), "3Widget");
  assert.equal(evaluateFormula("{{Qty}} + {{Flag}}", values), "4");
});

test("null references become 0 in numeric ops and empty in concat", () => {
  assert.equal(evaluateFormula("{{Empty}} + 5", values), "5");
  assert.equal(evaluateFormula("{{Name}} + {{Empty}}", values), "Widget");
  assert.equal(evaluateFormula("{{Empty}} * 4", values), "0");
});

test("numbers are trimmed to six decimals without trailing zeros", () => {
  assert.equal(evaluateFormula("1 / 3", values), "0.333333");
  assert.equal(evaluateFormula("2.500000 * 2", values), "5");
  assert.equal(evaluateFormula("0.1 + 0.2", values), "0.3");
});

test("malformed input returns the raw expression unchanged", () => {
  const raw = "{{Qty}} * ";
  assert.equal(evaluateFormula(raw, values), raw);
  assert.equal(evaluateFormula("{{Qty}} ++", values), "{{Qty}} ++");
  assert.equal(evaluateFormula("constructor.constructor('return 1')()", values), "constructor.constructor('return 1')()");
  assert.equal(evaluateFormula("{{title}}.constructor", {}), "{{title}}.constructor");
});

test("reference and depth caps force raw passthrough", () => {
  const many = Array.from({ length: 21 }, (_, i) => `{{f${i}}}`).join("+");
  assert.equal(evaluateFormula(many, {}), many);
  const deep = "(".repeat(9) + "1" + ")".repeat(9);
  assert.equal(evaluateFormula(deep, {}), deep);
  assert.equal(evaluateFormula("(".repeat(8) + "1" + ")".repeat(8), {}), "1");
});

test("missing or inherited references preserve the expression instead of inventing zero", () => {
  for (const raw of ["{{Missing}} * 2", "{{constructor}}", "{{toString}}", "=IF(1,2,{{Missing}})"]) {
    assert.equal(evaluateFormula(raw, values), raw);
  }
  const removed = { ...values } as Record<string, string | number | boolean | null>;
  delete removed.Qty;
  assert.equal(evaluateFormula("{{Qty}} * 2", removed), "{{Qty}} * 2");
});

test("optional leading equals and unary signs preserve arithmetic precedence", () => {
  for (const [raw, expected] of [
    ["  = 2 + 3 * 4", "14"], ["=20 / 2 / 5", "2"], ["=2 * -3 + +4", "-2"],
    ["=-(2 + 3) * 2", "-10"], ["=10 % 4 * 3", "6"], ["=1 + 2 * 3 = 7", "true"],
  ]) assert.equal(evaluateFormula(raw, values), expected, raw);
});

test("allowlisted functions accept expressions, references, nesting and mixed case", () => {
  for (const [raw, expected] of [
    ["=sUm({{Qty}}, {{Price}}, 1 * 2)", "7.5"],
    ["AVERAGE(1,2,6)", "3"], ["min(-3,2,0)", "-3"], ["MaX(-3,2,0)", "2"],
    ["ABS(-{{Qty}})", "3"], ["SUM(ABS(-2), MAX(3, 4))", "6"],
    ["SUM({{Flag}},{{Empty}},2)", "3"], ["AVERAGE({{Empty}},4)", "2"],
    ['SUM("2",3)', "5"], ['CONCAT("Item: ",{{Name}}," / ",{{Qty}})', "Item: Widget / 3"],
    ['CONCAT({{Flag}},{{Empty}},1/3)', "true0.333333"],
    ['CONCAT("")', ""], ['IF(1,"yes","no")', "yes"],
  ]) assert.equal(evaluateFormula(raw, values), expected, raw);
});

test("ROUND uses half-away-from-zero ties and integer positive or negative precision", () => {
  for (const [raw, expected] of [
    ["ROUND(1.005,2)", "1.01"], ["ROUND(-1.005,2)", "-1.01"],
    ["ROUND(2.5,0)", "3"], ["ROUND(-2.5,0)", "-3"],
    ["ROUND(125,-1)", "130"], ["ROUND(-125,-1)", "-130"],
    ["ROUND(1234,-2)", "1200"], ["ROUND(1.23456789,7)", "1.234568"],
    ["ROUND(0,308)", "0"], ["ROUND(1,-308)", "0"],
  ]) assert.equal(evaluateFormula(raw, values), expected, raw);
  for (const raw of ["ROUND(1,0.5)", "ROUND(1,309)", "ROUND(1,-309)", "ROUND(10,308)"]) {
    assert.equal(evaluateFormula(raw, values), raw);
  }
});

test("quoted literals use doubled double-quotes, with punctuation kept literal", () => {
  for (const [raw, expected] of [
    ['="He said ""Hi"""', 'He said "Hi"'], ['=""', ""], ['=""""', '"'],
    ['CONCAT("{{Missing}}",",()=<>!", " + ")', "{{Missing}},()=<>! + "],
    ['="C:\\files"', "C:\\files"], ['="Qty=" + {{Qty}}', "Qty=3"],
    ['={{Empty}} + "x"', "x"], ['="2" + 3', "23"], ['="2" * 3', "6"],
  ]) assert.equal(evaluateFormula(raw, values), expected, raw);
  for (const raw of ['="unterminated', '="abc""', "='single'", '="a" "b"', '="2" - 1']) {
    assert.equal(evaluateFormula(raw, values), raw);
  }
});

test("comparisons produce booleans and bind below arithmetic", () => {
  for (const [raw, expected] of [
    ["=3=3", "true"], ["=3<>3", "false"], ["=3!=4", "true"],
    ["=3>2", "true"], ["=3>=3", "true"], ["=3<2", "false"], ["=3<=3", "true"],
    ["=2+3>2*2", "true"], ['="a"="a"', "true"], ['="a"<>"b"', "true"],
    ['="b">"a"', "true"], ["={{Flag}}=1", "true"], ["={{Empty}}=0", "true"],
    ["=(1<2) + 2", "3"], ['="x"+(1<2)', "xtrue"],
    ["=IF({{Flag}},1,2)", "1"], ["=IF({{Empty}},1,2)", "2"],
    ['=IF("",1,2)', "2"], ["={{Flag}}", "true"], ["={{Empty}}", "null"],
  ]) assert.equal(evaluateFormula(raw, values), expected, raw);
});

test("IF evaluates only the chosen branch but validates both branches", () => {
  const raw = "=IF({{Qty}}>0,100/{{Qty}},0)";
  assert.equal(evaluateFormula(raw, { Qty: 0 }), "0");
  assert.equal(evaluateFormula(raw, { Qty: 4 }), "25");
  assert.equal(evaluateFormula('IF(1,7,ABS("text"))', {}), "7");
  assert.equal(evaluateFormula("IF(0,1/0,IF(1,5,0/0))", {}), "5");
  for (const expression of [
    "IF(1,1,2+)", "IF(0,SUM(),1)", "IF(1,2,ABS(1,2))", "IF(0,ROUND(1),2)",
    "IF(1,2,UNKNOWN(1))", "IF(1,2,(3)", "IF(1,1/0,2)", "IF(0,2,0%0)",
  ]) assert.equal(evaluateFormula(expression, {}), expression);
});

test("empty arguments, incorrect arity and malformed operators return raw", () => {
  for (const raw of [
    "", "=", "==1", "()", "SUM", "SUM()", "AVERAGE()", "MIN()", "MAX()", "CONCAT()",
    "ABS()", "ROUND()", "IF()", "IF(1,2)", "IF(1,2,3,4)", "ABS(1,2)", "ROUND(1,2,3)",
    "SUM(,1)", "SUM(1,)", "SUM(1,,2)", "SUM(1 2)", "1,2", "(1,2)",
    "1==1", "1===1", "1=>2", "1!2", "1><2", "1&&2", "2**3", "1..2", "{{}}", "{{Qty}",
  ]) assert.equal(evaluateFormula(raw, values), raw);
});

test("non-finite values and intermediate arithmetic cannot become successful output", () => {
  for (const raw of ["1/0", "0/0", "1%0", 'CONCAT(1/0,"x")', "IF(1/0,1,2)", "SUM(1/0,2)"]) {
    assert.equal(evaluateFormula(raw, {}), raw);
  }
  for (const value of [Infinity, -Infinity, NaN]) {
    for (const raw of ["{{N}}", '{{N}}+"x"', "ABS({{N}})", "{{N}}=1"]) {
      assert.equal(evaluateFormula(raw, { N: value }), raw);
    }
  }
  for (const raw of ["{{N}}*2", "SUM({{N}},{{N}})", "({{N}}*2)*0"]) {
    assert.equal(evaluateFormula(raw, { N: Number.MAX_VALUE }), raw);
  }
  assert.equal(evaluateFormula("{{N}}", { N: 1.2e30 }), "1.2e+30");
  assert.equal(evaluateFormula("-0.0000001", {}), "0");
  assert.equal(evaluateFormula("{{Flag}}+1", { Flag: false }), "1");
});

test("references stay raw and cannot execute formulas, code or property access", () => {
  assert.equal(evaluateFormula("{{Other}}", { Other: "=SUM(1,2)" }), "=SUM(1,2)");
  assert.equal(evaluateFormula('CONCAT({{Other}},"!")', { Other: "=SUM(1,2)" }), "=SUM(1,2)!");
  assert.equal(evaluateFormula("{{Other}}*2", { Other: "=SUM(1,2)" }), "{{Other}}*2");
  for (const raw of [
    "=eval(1)", '=Function("return 1")()', '=fetch("https://example.com")',
    "=globalThis", "=process.exit()", "=Math.abs(-1)", "=SUM.constructor(1)",
    "=constructor(1)", "=__proto__", "={{Qty}}.toString()", "={{Qty}}[0]", "=1;2",
    "=IF(1,2,globalThis)", "=1/*comment*/+2", "=1//2", "=1e3",
  ]) assert.equal(evaluateFormula(raw, values), raw);
});

test("length, reference occurrences and combined recursive depth are bounded", () => {
  const boundary = '="' + "a".repeat(197) + '"';
  assert.equal(boundary.length, 200);
  assert.equal(evaluateFormula(boundary, {}), "a".repeat(197));
  assert.equal(evaluateFormula(boundary + " ", {}), boundary + " ");
  for (const count of [20, 21]) {
    const raw = Array(count).fill("{{x}}").join("+");
    assert.equal(evaluateFormula(raw, { x: 1 }), count === 20 ? "20" : raw);
    const named = Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, 1]));
    const unique = Object.keys(named).map((key) => `{{${key}}}`).join("+");
    assert.equal(evaluateFormula(unique, named), count === 20 ? "20" : unique);
  }
  for (const count of [8, 9]) {
    for (const raw of ["-".repeat(count) + "1", "ABS(".repeat(count) + "1" + ")".repeat(count)]) {
      assert.equal(evaluateFormula(raw, {}), count === 8 ? "1" : raw);
    }
  }
  const mixed = "IF(1,2," + "ABS(".repeat(8) + "1" + ")".repeat(8) + ")";
  assert.equal(evaluateFormula(mixed, {}), mixed);
  const skippedRefs = "IF(1,2," + Array(21).fill("{{x}}").join("+") + ")";
  assert.equal(evaluateFormula(skippedRefs, { x: 1 }), skippedRefs);
  assert.equal(evaluateFormula("-(-(-(-1)))", {}), "1");
});
