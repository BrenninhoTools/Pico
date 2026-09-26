class Env {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }

  find(name) {
    for (let env = this; env; env = env.parent) {
      if (env.vars.has(name)) return env;
    }
    return null;
  }

  define(name, value) {
    this.vars.set(name, value);
  }
}

class PicoFunction {
  constructor(name, params, body, env, file) {
    this.name = name;
    this.params = params;
    this.body = body;
    this.env = env;
    this.file = file;
  }
}

class Native {
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }
}

function typeOf(value) {
  if (value === null) return 'nil';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Map) return 'map';
  if (value instanceof PicoFunction || value instanceof Native) return 'fn';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
}

function show(value, nested = false) {
  switch (typeOf(value)) {
    case 'nil':
      return 'nil';
    case 'string':
      return nested ? JSON.stringify(value) : value;
    case 'list':
      return `[${value.map((item) => show(item, true)).join(', ')}]`;
    case 'map':
      return `{${[...value].map(([key, item]) => `${key}: ${show(item, true)}`).join(', ')}}`;
    case 'fn':
      return value instanceof Native ? `<native ${value.name}>` : `<fn ${value.name || 'anonymous'}>`;
    default:
      return String(value);
  }
}

function equals(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => equals(item, b[i]));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, item] of a) {
      if (!b.has(key) || !equals(item, b.get(key))) return false;
    }
    return true;
  }
  return false;
}

function truthy(value) {
  return value !== null && value !== false;
}

module.exports = { Env, PicoFunction, Native, typeOf, show, equals, truthy };
