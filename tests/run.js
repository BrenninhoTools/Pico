const fs = require('fs');
const path = require('path');
const { Interpreter } = require('../src/interpreter');
const { PicoError } = require('../src/errors');

const casesDir = path.join(__dirname, 'cases');
const failures = [];
let total = 0;

function check(name, actual, expected) {
  total++;
  if (actual !== expected) failures.push({ name, actual, expected });
}

function runSource(source) {
  let output = '';
  const interpreter = new Interpreter({ out: (text) => { output += text; } });
  try {
    interpreter.runSource(source, 'test.pico');
  } catch (e) {
    if (!(e instanceof PicoError)) throw e;
    return { output, error: e.format() };
  }
  return { output, error: null };
}

for (const file of fs.readdirSync(casesDir).filter((f) => f.endsWith('.pico')).sort()) {
  const source = fs.readFileSync(path.join(casesDir, file), 'utf8');
  const expectedFile = path.join(casesDir, file.replace(/\.pico$/, '.out'));
  const { output, error } = runSource(source);
  check(`${file} (no error)`, error, null);
  if (process.argv.includes('--update')) {
    fs.writeFileSync(expectedFile, output);
    continue;
  }
  const expected = fs.existsSync(expectedFile) ? fs.readFileSync(expectedFile, 'utf8') : '';
  check(`${file} (output)`, output, expected);
}

const errorCases = [
  ['undefined variable', 'let a = 1\nprint(b)', "test.pico:2:7: error: undefined variable 'b'"],
  ['bad operands', 'print(1 - "a")', "test.pico:1:9: error: cannot apply '-' to number and string"],
  ['native error location', '\n  len(1)', 'test.pico:2:6: error: len argument 1 must be string or list or map, got number'],
  ['arity', 'fn f(a) { return a }\nf(1, 2)', 'test.pico:2:2: error: f expects 1 argument(s), got 2'],
  ['break outside loop', 'break', "test.pico:1:1: error: 'break' outside of a loop"],
  ['return outside function', 'return 1', "test.pico:1:1: error: 'return' outside of a function"],
  ['unterminated string', 'print("abc', 'test.pico:1:7: error: unterminated string'],
  ['unexpected character', 'let a = @', "test.pico:1:9: error: unexpected character '@'"],
  ['missing brace', 'if true {\n print(1)', "test.pico:2:10: error: expected '}', found end of file"],
  ['unknown module', 'use nothing', "test.pico:1:1: error: unknown module 'nothing'"],
  ['assign undeclared', 'x = 1', "test.pico:1:1: error: undefined variable 'x'"],
  ['uncaught throw', 'throw "boom"', 'test.pico:1:1: error: boom'],
  ['newline stops call', 'let f = fn() { return 1 }\nlet a = f\n(2)\nprint(a)', null],
];

for (const [name, source, expected] of errorCases) {
  const { error } = runSource(source);
  check(`error: ${name}`, error, expected);
}

if (failures.length === 0) {
  process.stdout.write(`all ${total} checks passed\n`);
} else {
  for (const f of failures) {
    process.stdout.write(`FAIL ${f.name}\n  expected: ${JSON.stringify(f.expected)}\n  actual:   ${JSON.stringify(f.actual)}\n`);
  }
  process.stdout.write(`${failures.length} of ${total} checks failed\n`);
  process.exitCode = 1;
}
