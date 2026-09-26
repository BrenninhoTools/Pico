const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { PicoError, ExitSignal } = require('./errors');
const { Native, typeOf, typeName, show, equals, truthy } = require('./values');

function fail(message) {
  throw new PicoError(message);
}

function native(name, spec, fn) {
  const min = spec.filter((s) => !s.endsWith('?')).length;
  return new Native(name, (args, interp, bound = 0) => {
    if (args.length < min || args.length > spec.length) {
      const lo = min - bound;
      const hi = spec.length - bound;
      const expected = lo === hi ? `${lo}` : `${lo} to ${hi}`;
      fail(`${name} expects ${expected} argument(s), got ${args.length - bound}`);
    }
    args.forEach((arg, i) => {
      const optional = spec[i].endsWith('?');
      const want = optional ? spec[i].slice(0, -1) : spec[i];
      if (want === 'any' || (optional && arg === null)) return;
      const allowed = want.split('|');
      if (!allowed.includes(typeOf(arg))) {
        const label = i < bound ? 'receiver' : `argument ${i + 1 - bound}`;
        fail(`${name} ${label} must be ${allowed.join(' or ')}, got ${typeOf(arg)}`);
      }
    });
    return fn(args, interp);
  });
}

function variadic(name, fn) {
  return new Native(name, (args, interp) => fn(args, interp));
}

function createInput() {
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.alloc(1024);
  let buffer = '';
  let ended = false;

  return function readLine() {
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        return line.replace(/\r$/, '');
      }
      if (ended) {
        if (buffer.length === 0) return null;
        const rest = buffer;
        buffer = '';
        return rest;
      }
      let count = 0;
      try {
        count = fs.readSync(0, chunk, 0, chunk.length, null);
      } catch (e) {
        if (e.code === 'EAGAIN') continue;
        if (e.code !== 'EOF') throw e;
      }
      if (count === 0) {
        buffer += decoder.end();
        ended = true;
      } else {
        buffer += decoder.write(chunk.subarray(0, count));
      }
    }
  };
}

function toJson(value) {
  switch (typeOf(value)) {
    case 'nil':
    case 'bool':
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : fail('cannot encode a non-finite number');
    case 'list':
      return value.map(toJson);
    case 'map':
      return Object.fromEntries([...value].map(([k, v]) => [k, toJson(v)]));
    default:
      return fail(`cannot encode ${typeOf(value)}`);
  }
}

function fromJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromJson);
  return new Map(Object.entries(value).map(([k, v]) => [k, fromJson(v)]));
}

function compareDefault(a, b) {
  const ta = typeOf(a);
  if (ta !== typeOf(b) || (ta !== 'number' && ta !== 'string')) {
    fail(`sort cannot compare ${ta} and ${typeOf(b)}`);
  }
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function createMathModule() {
  const unary = (name, fn) => native(name, ['number'], ([x]) => fn(x));
  return new Map([
    ['pi', Math.PI],
    ['e', Math.E],
    ['abs', unary('abs', Math.abs)],
    ['floor', unary('floor', Math.floor)],
    ['ceil', unary('ceil', Math.ceil)],
    ['round', unary('round', Math.round)],
    ['trunc', unary('trunc', Math.trunc)],
    ['sqrt', unary('sqrt', Math.sqrt)],
    ['sin', unary('sin', Math.sin)],
    ['cos', unary('cos', Math.cos)],
    ['tan', unary('tan', Math.tan)],
    ['log', unary('log', Math.log)],
    ['pow', native('pow', ['number', 'number'], ([a, b]) => a ** b)],
    ['min', variadic('min', (args) => {
      if (args.length === 0 || args.some((a) => typeof a !== 'number')) fail('min expects one or more numbers');
      return Math.min(...args);
    })],
    ['max', variadic('max', (args) => {
      if (args.length === 0 || args.some((a) => typeof a !== 'number')) fail('max expects one or more numbers');
      return Math.max(...args);
    })],
    ['random', native('random', [], () => Math.random())],
    ['randint', native('randint', ['number', 'number'], ([lo, hi]) => {
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) fail('randint expects integers with low <= high');
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    })],
  ]);
}

function createTextModule() {
  return new Map([
    ['upper', native('upper', ['string'], ([s]) => s.toUpperCase())],
    ['lower', native('lower', ['string'], ([s]) => s.toLowerCase())],
    ['trim', native('trim', ['string'], ([s]) => s.trim())],
    ['split', native('split', ['string', 'string'], ([s, sep]) => s.split(sep))],
    ['join', native('join', ['list', 'string?'], ([items, sep]) => items.map((item) => show(item)).join(sep ?? ''))],
    ['replace', native('replace', ['string', 'string', 'string'], ([s, from, to]) => s.split(from).join(to))],
    ['starts', native('starts', ['string', 'string'], ([s, prefix]) => s.startsWith(prefix))],
    ['ends', native('ends', ['string', 'string'], ([s, suffix]) => s.endsWith(suffix))],
    ['find', native('find', ['string', 'string'], ([s, sub]) => s.indexOf(sub))],
    ['repeat', native('repeat', ['string', 'number'], ([s, n]) => {
      if (!Number.isInteger(n) || n < 0) fail('repeat count must be a non-negative integer');
      return s.repeat(n);
    })],
    ['chars', native('chars', ['string'], ([s]) => Array.from(s))],
    ['lines', native('lines', ['string'], ([s]) => s.split(/\r?\n/))],
    ['pad_left', native('pad_left', ['string', 'number', 'string?'], ([s, width, fill]) => s.padStart(width, fill ?? ' '))],
    ['pad_right', native('pad_right', ['string', 'number', 'string?'], ([s, width, fill]) => s.padEnd(width, fill ?? ' '))],
  ]);
}

function createReModule() {
  const compile = (pattern, flags = '') => {
    try {
      return new RegExp(pattern, flags);
    } catch (e) {
      return fail(`invalid pattern: ${e.message}`);
    }
  };
  const groups = (m) => m.slice(1).map((g) => g ?? null);
  return new Map([
    ['test', native('test', ['string', 'string'], ([pattern, s]) => compile(pattern).test(s))],
    ['match', native('match', ['string', 'string'], ([pattern, s]) => {
      const m = compile(pattern).exec(s);
      if (!m) return null;
      return new Map([['text', m[0]], ['index', m.index], ['groups', groups(m)]]);
    })],
    ['find_all', native('find_all', ['string', 'string'], ([pattern, s]) => [...s.matchAll(compile(pattern, 'g'))].map((m) => m[0]))],
    ['replace', native('replace', ['string', 'string', 'string'], ([pattern, s, repl]) => s.replace(compile(pattern, 'g'), repl))],
    ['split', native('split', ['string', 'string'], ([pattern, s]) => s.split(compile(pattern)))],
  ]);
}

function createFsModule() {
  return new Map([
    ['read', native('read', ['string'], ([p]) => fs.readFileSync(p, 'utf8'))],
    ['write', native('write', ['string', 'string'], ([p, text]) => {
      fs.writeFileSync(p, text);
      return null;
    })],
    ['append', native('append', ['string', 'string'], ([p, text]) => {
      fs.appendFileSync(p, text);
      return null;
    })],
    ['exists', native('exists', ['string'], ([p]) => fs.existsSync(p))],
    ['lines', native('lines', ['string'], ([p]) => {
      const text = fs.readFileSync(p, 'utf8');
      if (text === '') return [];
      return text.replace(/\r?\n$/, '').split(/\r?\n/);
    })],
    ['remove', native('remove', ['string'], ([p]) => {
      fs.rmSync(p);
      return null;
    })],
    ['list', native('list', ['string'], ([p]) => fs.readdirSync(p))],
    ['join', variadic('join', (args) => {
      if (args.length === 0 || args.some((a) => typeof a !== 'string')) fail('join expects one or more strings');
      return path.join(...args);
    })],
  ]);
}

function createOsModule(args) {
  return new Map([
    ['args', [...args]],
    ['env', native('env', ['string'], ([name]) => process.env[name] ?? null)],
    ['platform', native('platform', [], () => os.platform())],
    ['cwd', native('cwd', [], () => process.cwd())],
  ]);
}

function createTimeModule() {
  return new Map([
    ['now', native('now', [], () => Date.now())],
    ['sleep', native('sleep', ['number'], ([ms]) => {
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return null;
    })],
  ]);
}

function createJsonModule() {
  return new Map([
    ['encode', native('encode', ['any', 'number?'], ([value, indent]) => JSON.stringify(toJson(value), null, indent ?? 0))],
    ['decode', native('decode', ['string'], ([s]) => {
      try {
        return fromJson(JSON.parse(s));
      } catch (e) {
        return fail(`invalid json: ${e.message}`);
      }
    })],
  ]);
}

function createLibrary(out, args) {
  const readLine = createInput();
  const globals = new Map();
  const def = (native_) => globals.set(native_.name, native_);

  def(variadic('print', (values) => {
    out(`${values.map((v) => show(v)).join(' ')}\n`);
    return null;
  }));
  def(variadic('write', (values) => {
    out(values.map((v) => show(v)).join(' '));
    return null;
  }));
  def(native('input', ['string?'], ([prompt]) => {
    if (prompt !== null && prompt !== undefined) out(prompt);
    return readLine();
  }));
  def(native('len', ['string|list|map'], ([v]) => (v instanceof Map ? v.size : v.length)));
  def(native('str', ['any'], ([v]) => show(v)));
  def(native('num', ['any'], ([v]) => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string' || v.trim() === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }));
  def(native('type', ['any'], ([v]) => typeName(v)));
  def(native('range', ['number', 'number?', 'number?'], ([a, b, step]) => {
    const [start, stop] = b === null || b === undefined ? [0, a] : [a, b];
    const by = step ?? 1;
    if (by === 0) fail('range step cannot be zero');
    const result = [];
    for (let i = start; by > 0 ? i < stop : i > stop; i += by) result.push(i);
    return result;
  }));
  def(native('push', ['list', 'any'], ([list, item]) => {
    list.push(item);
    return list;
  }));
  def(native('pop', ['list'], ([list]) => (list.length ? list.pop() : null)));
  def(native('remove', ['list|map', 'any'], ([target, key]) => {
    if (target instanceof Map) {
      const old = target.has(key) ? target.get(key) : null;
      target.delete(key);
      return old;
    }
    if (!Number.isInteger(key) || key < 0 || key >= target.length) fail(`index ${show(key)} out of range`);
    return target.splice(key, 1)[0];
  }));
  def(native('has', ['string|list|map', 'any'], ([target, item]) => {
    if (target instanceof Map) return target.has(item);
    if (typeof target === 'string') {
      if (typeof item !== 'string') fail('has on a string needs a string');
      return target.includes(item);
    }
    return target.some((x) => equals(x, item));
  }));
  def(native('keys', ['map'], ([m]) => [...m.keys()]));
  def(native('values', ['map'], ([m]) => [...m.values()]));
  def(native('slice', ['string|list', 'number', 'number?'], ([v, from, to]) => v.slice(from, to ?? undefined)));
  def(native('reverse', ['string|list'], ([v]) => (typeof v === 'string' ? Array.from(v).reverse().join('') : [...v].reverse())));
  def(native('sort', ['list', 'fn?'], ([list, cmp], interp) => {
    const copy = [...list];
    if (cmp === null || cmp === undefined) return copy.sort(compareDefault);
    return copy.sort((a, b) => {
      const r = interp.call(cmp, [a, b], null);
      if (typeof r !== 'number') fail('sort comparator must return a number');
      return r;
    });
  }));
  def(native('map', ['list', 'fn'], ([list, f], interp) => list.map((x) => interp.call(f, [x], null))));
  def(native('filter', ['list', 'fn'], ([list, f], interp) => list.filter((x) => truthy(interp.call(f, [x], null)))));
  def(native('reduce', ['list', 'fn', 'any'], ([list, f, init], interp) => list.reduce((acc, x) => interp.call(f, [acc, x], null), init)));
  def(native('each', ['list', 'fn'], ([list, f], interp) => {
    list.forEach((x) => interp.call(f, [x], null));
    return null;
  }));
  def(native('sum', ['list'], ([list]) => {
    let total = 0;
    for (const x of list) {
      if (typeof x !== 'number') fail(`sum expects numbers, got ${typeOf(x)}`);
      total += x;
    }
    return total;
  }));
  def(native('any', ['list', 'fn?'], ([list, f], interp) => list.some((x) => truthy(f ? interp.call(f, [x], null) : x))));
  def(native('all', ['list', 'fn?'], ([list, f], interp) => list.every((x) => truthy(f ? interp.call(f, [x], null) : x))));
  def(native('find', ['list', 'fn'], ([list, f], interp) => {
    for (const x of list) {
      if (truthy(interp.call(f, [x], null))) return x;
    }
    return null;
  }));
  def(native('first', ['list'], ([list]) => (list.length ? list[0] : null)));
  def(native('last', ['list'], ([list]) => (list.length ? list[list.length - 1] : null)));
  def(native('index_of', ['list|string', 'any'], ([subject, item]) => {
    if (typeof subject !== 'string') return subject.findIndex((x) => equals(x, item));
    if (typeof item !== 'string') fail('index_of on a string needs a string');
    return subject.indexOf(item);
  }));
  def(native('flat', ['list'], ([list]) => list.flatMap((x) => (Array.isArray(x) ? x : [x]))));
  def(native('unique', ['list'], ([list]) => {
    const seen = [];
    for (const x of list) {
      if (!seen.some((y) => equals(x, y))) seen.push(x);
    }
    return seen;
  }));
  def(native('zip', ['list', 'list'], ([a, b]) => Array.from({ length: Math.min(a.length, b.length) }, (_, i) => [a[i], b[i]])));
  def(native('entries', ['map'], ([m]) => [...m].map(([k, v]) => [k, v])));
  def(native('from_entries', ['list'], ([pairs]) => new Map(pairs.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
      fail('from_entries expects [key, value] pairs with string keys');
    }
    return pair;
  }))));
  def(native('copy', ['list|map'], ([v]) => (Array.isArray(v) ? [...v] : new Map(v))));
  def(native('join', ['list', 'string?'], ([items, sep]) => items.map((item) => show(item)).join(sep ?? '')));
  def(native('assert', ['any', 'string?'], ([cond, message]) => {
    if (!truthy(cond)) fail(message ?? 'assertion failed');
    return null;
  }));
  def(native('exit', ['number?'], ([code]) => {
    throw new ExitSignal(code ?? 0);
  }));

  const modules = new Map([
    ['math', createMathModule()],
    ['text', createTextModule()],
    ['fs', createFsModule()],
    ['os', createOsModule(args)],
    ['time', createTimeModule()],
    ['json', createJsonModule()],
    ['re', createReModule()],
  ]);

  const pick = (names) => new Map(names.map((name) => [name, globals.get(name)]));
  const textMethods = [...modules.get('text')].filter(([name, value]) => value instanceof Native && name !== 'join');
  const methods = new Map([
    ['list', pick(['len', 'push', 'pop', 'remove', 'has', 'slice', 'reverse', 'sort', 'map', 'filter', 'reduce', 'each', 'sum', 'any', 'all', 'find', 'first', 'last', 'index_of', 'flat', 'unique', 'zip', 'join', 'copy', 'str'])],
    ['string', new Map([...pick(['len', 'slice', 'reverse', 'has', 'str', 'num', 'index_of']), ...textMethods])],
    ['map', pick(['len', 'keys', 'values', 'entries', 'has', 'remove', 'copy', 'str'])],
    ['number', pick(['str'])],
    ['bool', pick(['str'])],
    ['nil', pick(['str'])],
  ]);

  return { globals, modules, methods };
}

module.exports = { createLibrary };
