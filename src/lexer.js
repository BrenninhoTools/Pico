const { PicoError } = require('./errors');

const KEYWORDS = new Set([
  'let', 'fn', 'return', 'if', 'else', 'while', 'for', 'in', 'break', 'continue',
  'true', 'false', 'nil', 'and', 'or', 'not', 'use', 'as', 'try', 'catch', 'throw',
]);

const DOUBLE = new Set(['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=']);
const SINGLE = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '{', '}', '[', ']', ',', '.', ':', ';']);
const ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'" };

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

function tokenize(source, file) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let newline = false;

  const fail = (message, l, c) => {
    throw new PicoError(message, { file, line: l, col: c });
  };

  const step = () => {
    const ch = source[i++];
    if (ch === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };

  const emit = (type, value, l, c) => {
    tokens.push({ type, value, line: l, col: c, newline });
    newline = false;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') {
      step();
      newline = true;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      step();
      continue;
    }

    const l = line;
    const c = col;

    if (isDigit(ch)) {
      let text = '';
      while (isDigit(source[i])) text += step();
      if (source[i] === '.' && isDigit(source[i + 1])) {
        text += step();
        while (isDigit(source[i])) text += step();
      }
      emit('number', Number(text), l, c);
      continue;
    }

    if (isIdentStart(ch)) {
      let text = '';
      while (i < source.length && isIdentPart(source[i])) text += step();
      emit(KEYWORDS.has(text) ? 'keyword' : 'ident', text, l, c);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = step();
      let text = '';
      for (;;) {
        if (i >= source.length || source[i] === '\n') fail('unterminated string', l, c);
        const d = step();
        if (d === quote) break;
        if (d === '\\') {
          if (i >= source.length) fail('unterminated string', l, c);
          const escapeLine = line;
          const escapeCol = col - 1;
          const e = step();
          if (!Object.hasOwn(ESCAPES, e)) fail(`unknown escape '\\${e}'`, escapeLine, escapeCol);
          text += ESCAPES[e];
        } else {
          text += d;
        }
      }
      emit('string', text, l, c);
      continue;
    }

    const pair = source.slice(i, i + 2);
    if (DOUBLE.has(pair)) {
      step();
      step();
      emit('op', pair, l, c);
      continue;
    }

    if (SINGLE.has(ch)) {
      step();
      emit('op', ch, l, c);
      continue;
    }

    fail(`unexpected character '${ch}'`, l, c);
  }

  emit('eof', null, line, col);
  return tokens;
}

module.exports = { tokenize };
