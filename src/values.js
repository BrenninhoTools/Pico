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
    this.hasRest = params.some((p) => p.rest);
    this.minArgs = params.filter((p) => !p.init && !p.rest).length;
    this.maxArgs = this.hasRest ? Infinity : params.length;
  }
}

class Native {
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }
}

class StructType {
  constructor(name, fields, methods) {
    this.name = name;
    this.fields = fields;
    this.methods = methods;
  }
}

class Instance {
  constructor(type, fields) {
    this.type = type;
    this.fields = fields;
  }
}

class BoundMethod {
  constructor(fn, self) {
    this.fn = fn;
    this.self = self;
  }
}

function typeOf(value) {
  if (value === null) return 'nil';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Map) return 'map';
  if (value instanceof Instance) return 'instance';
  if (value instanceof StructType) return 'struct';
  if (value instanceof PicoFunction || value instanceof Native || value instanceof BoundMethod) return 'fn';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
}

function typeName(value) {
  return value instanceof Instance ? value.type.name : typeOf(value);
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
    case 'instance':
      return `${value.type.name}(${[...value.fields].map(([key, item]) => `${key}: ${show(item, true)}`).join(', ')})`;
    case 'struct':
      return `<struct ${value.name}>`;
    case 'fn':
      if (value instanceof Native) return `<native ${value.name}>`;
      if (value instanceof BoundMethod) return `<method ${value.fn.name}>`;
      return `<fn ${value.name || 'anonymous'}>`;
    default:
      return String(value);
  }
}

function equals(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => equals(item, b[i]));
  }
  if (a instanceof Map && b instanceof Map) return sameEntries(a, b);
  if (a instanceof Instance && b instanceof Instance) {
    return a.type === b.type && sameEntries(a.fields, b.fields);
  }
  return false;
}

function sameEntries(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, item] of a) {
    if (!b.has(key) || !equals(item, b.get(key))) return false;
  }
  return true;
}

function truthy(value) {
  return value !== null && value !== false;
}

module.exports = {
  Env,
  PicoFunction,
  Native,
  StructType,
  Instance,
  BoundMethod,
  typeOf,
  typeName,
  show,
  equals,
  truthy,
};
