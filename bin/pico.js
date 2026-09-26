#!/usr/bin/env node
const path = require('path');
const readline = require('readline');
const { Interpreter } = require('../src/interpreter');
const { PicoError, ExitSignal } = require('../src/errors');
const { show } = require('../src/values');
const { version } = require('../package.json');

const USAGE = `Pico ${version}

usage:
  pico <file.pico> [args...]   run a program
  pico run <file.pico> [args...]
  pico repl                    start an interactive session
  pico --version
  pico --help
`;

function report(e) {
  if (e instanceof PicoError) {
    process.stderr.write(`${e.format()}\n`);
  } else {
    process.stderr.write(`error: ${e.message}\n`);
  }
  return 1;
}

function runProgram(file, args) {
  if (path.extname(file) !== '.pico') {
    process.stderr.write(`error: expected a .pico file, got '${file}'\n`);
    return 1;
  }
  const interpreter = new Interpreter({ args });
  try {
    interpreter.runFile(file);
    return 0;
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    return report(e);
  }
}

function balance(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if ('([{'.includes(ch)) {
      depth++;
    } else if (')]}'.includes(ch)) {
      depth--;
    }
  }
  return depth;
}

function repl() {
  const interpreter = new Interpreter();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'pico> ' });
  let pending = '';

  rl.prompt();
  rl.on('line', (line) => {
    pending += `${line}\n`;
    if (balance(pending) > 0) {
      rl.setPrompt('  ... ');
      rl.prompt();
      return;
    }
    const source = pending;
    pending = '';
    rl.setPrompt('pico> ');
    try {
      const result = interpreter.runRepl(source);
      if (result !== null && result !== undefined) process.stdout.write(`${show(result, true)}\n`);
    } catch (e) {
      if (e instanceof ExitSignal) {
        process.exitCode = e.code;
        rl.close();
        return;
      }
      report(e);
    }
    rl.prompt();
  });
}

function main(argv) {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'repl') {
    if (first === undefined && !process.stdin.isTTY) {
      process.stdout.write(USAGE);
      return 0;
    }
    repl();
    return null;
  }
  if (first === '--help' || first === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (first === 'run') {
    if (rest.length === 0) {
      process.stderr.write('error: missing file\n');
      return 1;
    }
    return runProgram(rest[0], rest.slice(1));
  }
  return runProgram(first, rest);
}

const code = main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
