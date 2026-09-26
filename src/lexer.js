const { PicoError } = require('./errors');

const KEYWORDS = new Set([
  'let', 'fn', 'return', 'if', 'else', 'while', 'for', 'in', 'break', 'continue',
  'true', 'false', 'nil', 'and', 'or', 'not', 'use', 'as', 'try', 'catch', 'throw',
  'struct',
]);

const TRIPLE = new Set(['...', '..=']);
const DOUBLE = new Set(['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '..', '|>']);
const SINGLE = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '{', '}', '[', ']', ',', '.', ':', ';', '?']);
const ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'", '{': '{', '}': '}' };

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

  const atLineEnd = () => i >= source.length || source[i] === '\n';

  const readNestedString = (quote, l, c) => {
    let text = '';
    for (;;) {
      if (atLineEnd()) fail('unterminated string', l, c);
      const ch = step();
      text += ch;
      if (ch === '\\' && i < source.length) text += step();
      else if (ch === quote) return text;
    }
  };

  const readInterpolation = (l, c) => {
    let depth = 1;
    let code = '';
    for (;;) {
      if (atLineEnd()) fail('unterminated interpolation', l, c);
      const ch = step();
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          if (code.trim() === '') fail('empty interpolation', l, c);
          return code;
        }
      }
      code += ch;
      if (ch === '"' || ch === "'") code += readNestedString(ch, l, c);
    }
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

    if (ch === '`') {
      step();
      let text = '';
      while (source[i] !== '`') {
        if (atLineEnd()) fail('unterminated raw string', l, c);
        text += step();
      }
      step();
      emit('string', text, l, c);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = step();
      const parts = [];
      let text = '';
      for (;;) {
        if (atLineEnd()) fail('unterminated string', l, c);
        const d = step();
        if (d === quote) break;
        if (d === '\\') {
          if (i >= source.length) fail('unterminated string', l, c);
          const escapeLine = line;
          const escapeCol = col - 1;
          const e = step();
          if (!Object.hasOwn(ESCAPES, e)) fail(`unknown escape '\\${e}'`, escapeLine, escapeCol);
          text += ESCAPES[e];
        } else if (d === '{') {
          if (text !== '') parts.push(text);
          text = '';
          parts.push({ code: readInterpolation(l, c), line: l, col: c });
        } else {
          text += d;
        }
      }
      if (parts.length === 0) {
        emit('string', text, l, c);
      } else {
        if (text !== '') parts.push(text);
        emit('template', parts, l, c);
      }
      continue;
    }

    const triple = source.slice(i, i + 3);
    if (TRIPLE.has(triple)) {
      step();
      step();
      step();
      emit('op', triple, l, c);
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
