import { safeJsonParse } from "../src/json-utils.js";

const cases: Array<[string, unknown]> = [
  ['{"a":1}', { a: 1 }],
  ['```json\n{"b":2}\n```', { b: 2 }],
  ['text {"c":3} trailing', { c: 3 }],
  ["{'d':4}", { d: 4 }],
  ['{"e":5,}', { e: 5 }],
  ['', null],
  ['not json', null],
  ['[1,2,3]', [1, 2, 3]],
  ['{"x":1,"y":[2,3]}', { x: 1, y: [2, 3] }],
];

let ok = 0;
for (const [input, expected] of cases) {
  const got = safeJsonParse(input);
  const pass = JSON.stringify(got) === JSON.stringify(expected);
  if (pass) {
    ok++;
  } else {
    console.log(`FAIL: ${JSON.stringify(input)} => ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
}
console.log(`${ok}/${cases.length} passed`);
process.exit(ok === cases.length ? 0 : 1);
