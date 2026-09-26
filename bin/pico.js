#!/usr/bin/env node
const path = require('path');
const readline = require('readline');
const { Worker, isMainThread, workerData } = require('worker_threads');
const { Interpreter } = require('../src/interpreter');
const { PicoError, ExitSignal } = require('../src/errors');
const { show } = require('../src/values');
const { version } = require('../package.json');

const WORKER_STACK_MB = 512;
const WORKER_MAX_DEPTH = 100000;

const USAGE = `Pico ${version}

usage:
  pico <file.pico> [args...]   run a program
  pico run <file.pico> [args...]
  pico check <file.pico>       parse a program without running it
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
}

function requirePicoFile(file) {
  if (path.extname(file) === '.pico') return true;
  process.stderr.write(`error: expected a .pico file, got '${file}'\n`);
  return false;
}

function execute({ file, args }) {
  const interpreter = new Interpreter({ args, maxDepth: WORKER_MAX_DEPTH });
  try {
    interpreter.runFile(file);
    process.exitCode = 0;
  } catch (e) {
    if (e instanceof ExitSignal) {
      process.exitCode = e.code;
      return;
    }
    report(e);
    process.exitCode = 1;
  }
}

function runProgram(file, args) {
  if (!requirePicoFile(file)) return 1;
  const worker = new Worker(__filename, {
    workerData: { file, args },
    resourceLimits: { stackSizeMb: WORKER_STACK_MB },
  });
  worker.on('error', (e) => {
    report(e);
    process.exitCode = 1;
  });
  worker.on('exit', (code) => {
    if (process.exitCode === undefined) process.exitCode = code;
  });
  return null;
}

function checkProgram(file) {
  if (!requirePicoFile(file)) return 1;
  try {
    new Interpreter().check(file);
    process.stdout.write(`${file}: ok\n`);
    return 0;
  } catch (e) {
    report(e);
    return 1;
  }
}

function balance(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote !== '`') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
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
  if (first === 'check') {
    if (rest.length === 0) {
      process.stderr.write('error: missing file\n');
      return 1;
    }
    return checkProgram(rest[0]);
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

if (isMainThread) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
} else {
  execute(workerData);
}
