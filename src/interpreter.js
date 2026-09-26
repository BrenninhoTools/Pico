const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');
const { PicoError, ExitSignal } = require('./errors');
const { createLibrary } = require('./stdlib');
const {
  Env, PicoFunction, Native, StructType, Instance, BoundMethod, typeOf, show, equals, truthy,
} = require('./values');

const DEFAULT_MAX_DEPTH = 1000;
const BREAK = { kind: 'break' };
const CONTINUE = { kind: 'continue' };

class ReturnSignal {
  constructor(value) {
    this.kind = 'return';
    this.value = value;
  }
}

class Interpreter {
  constructor({ args = [], out = (text) => process.stdout.write(text), maxDepth = DEFAULT_MAX_DEPTH } = {}) {
    const library = createLibrary(out, args);
    this.globals = new Env();
    for (const [name, value] of library.globals) this.globals.define(name, value);
    this.builtinModules = library.modules;
    this.methods = library.methods;
    this.maxDepth = maxDepth;
    this.imports = new Map();
    this.file = '<main>';
    this.depth = 0;
    this.replEnv = new Env(this.globals);
  }

  error(node, message) {
    const pos = node ? { file: this.file, line: node.line, col: node.col } : {};
    return new PicoError(message, pos);
  }

  normalize(e, node) {
    if (e instanceof ExitSignal) return e;
    let err = e;
    if (e instanceof RangeError && /call stack/i.test(e.message)) {
      err = new PicoError('maximum call depth exceeded');
    } else if (!(e instanceof PicoError)) {
      err = new PicoError(e.message);
    }
    if (err.line === undefined && node) {
      err.file = this.file;
      err.line = node.line;
      err.col = node.col;
    }
    return err;
  }

  check(filePath) {
    const resolved = path.resolve(filePath);
    parse(this.readSource(filePath, resolved), resolved);
  }

  readSource(filePath, resolved) {
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw new PicoError(`cannot read '${filePath}': ${e.code || e.message}`);
    }
  }

  runFile(filePath, env = new Env(this.globals)) {
    const resolved = path.resolve(filePath);
    return this.runSource(this.readSource(filePath, resolved), resolved, env);
  }

  runSource(source, file, env = new Env(this.globals)) {
    const previous = this.file;
    this.file = file;
    try {
      const program = parse(source, file);
      const signal = this.execBlock(program.body, env);
      return { env, signal };
    } catch (e) {
      throw this.normalize(e, null);
    } finally {
      this.file = previous;
    }
  }

  runRepl(source) {
    const previous = this.file;
    this.file = '<repl>';
    try {
      const program = parse(source, '<repl>');
      let result = null;
      for (const stmt of program.body) {
        if (stmt.type === 'ExprStmt') {
          result = this.eval(stmt.expr, this.replEnv);
        } else {
          this.exec(stmt, this.replEnv);
          result = null;
        }
      }
      return result;
    } catch (e) {
      throw this.normalize(e, null);
    } finally {
      this.file = previous;
    }
  }

  execBlock(body, env) {
    for (const stmt of body) {
      const signal = this.exec(stmt, env);
      if (signal) return signal;
    }
    return undefined;
  }

  exec(node, env) {
    switch (node.type) {
      case 'ExprStmt':
        this.eval(node.expr, env);
        return undefined;
      case 'Let':
        env.define(node.name, this.eval(node.value, env));
        return undefined;
      case 'Assign':
        this.assign(node, env);
        return undefined;
      case 'Block':
        return this.execBlock(node.body, new Env(env));
      case 'If':
        if (truthy(this.eval(node.cond, env))) return this.execBlock(node.then.body, new Env(env));
        if (node.otherwise) return this.exec(node.otherwise, env);
        return undefined;
      case 'While':
        return this.execWhile(node, env);
      case 'For':
        return this.execFor(node, env);
      case 'Return':
        return new ReturnSignal(node.value ? this.eval(node.value, env) : null);
      case 'Break':
        return BREAK;
      case 'Continue':
        return CONTINUE;
      case 'Use':
        this.execUse(node, env);
        return undefined;
      case 'Try':
        return this.execTry(node, env);
      case 'Struct':
        this.execStruct(node, env);
        return undefined;
      case 'Throw': {
        const value = this.eval(node.value, env);
        throw new PicoError(show(value), { file: this.file, line: node.line, col: node.col }, value);
      }
      default:
        throw this.error(node, `unknown statement '${node.type}'`);
    }
  }

  execStruct(node, env) {
    const methods = new Map();
    env.define(node.name, new StructType(node.name, node.fields, methods));
    for (const { name, fn } of node.methods) {
      methods.set(name, new PicoFunction(fn.name, fn.params, fn.body, env, this.file));
    }
  }

  loopStep(node, scope) {
    const signal = this.execBlock(node.body.body, scope);
    return signal === CONTINUE ? undefined : signal;
  }

  execWhile(node, env) {
    while (truthy(this.eval(node.cond, env))) {
      const signal = this.loopStep(node, new Env(env));
      if (signal === BREAK) break;
      if (signal) return signal;
    }
    return undefined;
  }

  execFor(node, env) {
    const single = node.second === null;

    if (node.iterable.type === 'Range') {
      const [from, to] = this.rangeBounds(node.iterable, env);
      for (let n = from; n < to; n++) {
        const scope = new Env(env);
        scope.define(node.first, single ? n : n - from);
        if (!single) scope.define(node.second, n);
        const signal = this.loopStep(node, scope);
        if (signal === BREAK) break;
        if (signal) return signal;
      }
      return undefined;
    }

    const subject = this.eval(node.iterable, env);
    let entries;
    if (Array.isArray(subject)) {
      entries = subject.map((item, i) => [i, item]);
    } else if (typeof subject === 'string') {
      entries = Array.from(subject).map((ch, i) => [i, ch]);
    } else if (subject instanceof Map) {
      entries = [...subject];
    } else {
      throw this.error(node.iterable, `cannot iterate over ${typeOf(subject)}`);
    }
    const isMap = subject instanceof Map;
    for (const [key, item] of entries) {
      const scope = new Env(env);
      if (single) {
        scope.define(node.first, isMap ? key : item);
      } else {
        scope.define(node.first, key);
        scope.define(node.second, item);
      }
      const signal = this.loopStep(node, scope);
      if (signal === BREAK) break;
      if (signal) return signal;
    }
    return undefined;
  }

  execTry(node, env) {
    try {
      return this.execBlock(node.body.body, new Env(env));
    } catch (e) {
      const err = this.normalize(e, node);
      if (err instanceof ExitSignal) throw err;
      const scope = new Env(env);
      scope.define(node.name, err.value);
      return this.execBlock(node.handler.body, scope);
    }
  }

  execUse(node, env) {
    if (node.isFile) {
      env.define(node.name, this.importFile(node));
      return;
    }
    const module = this.builtinModules.get(node.source);
    if (!module) throw this.error(node, `unknown module '${node.source}'`);
    env.define(node.name, module);
  }

  importFile(node) {
    const base = this.file.startsWith('<') ? process.cwd() : path.dirname(this.file);
    let target = path.resolve(base, node.source);
    if (path.extname(target) === '') target += '.pico';
    if (path.extname(target) !== '.pico') throw this.error(node, `'${node.source}' is not a .pico file`);
    if (this.imports.has(target)) {
      const cached = this.imports.get(target);
      if (cached === null) throw this.error(node, `circular import of '${node.source}'`);
      return cached;
    }
    this.imports.set(target, null);
    try {
      const { env } = this.runFile(target);
      const exports = new Map(env.vars);
      this.imports.set(target, exports);
      return exports;
    } catch (e) {
      this.imports.delete(target);
      throw e;
    }
  }

  assign(node, env) {
    const { target, op } = node;
    const rhs = this.eval(node.value, env);
    const combine = (current) => (op === '=' ? rhs : this.binary(op.slice(0, -1), current, rhs, node));

    if (target.type === 'Identifier') {
      const owner = env.find(target.name);
      if (!owner) throw this.error(target, `undefined variable '${target.name}'`);
      owner.vars.set(target.name, combine(owner.vars.get(target.name)));
      return;
    }

    const object = this.eval(target.object, env);
    if (target.type === 'Member') {
      if (object instanceof Instance) {
        if (!object.fields.has(target.name)) {
          throw this.error(target, `${object.type.name} has no field '${target.name}'`);
        }
        object.fields.set(target.name, combine(object.fields.get(target.name)));
        return;
      }
      if (!(object instanceof Map)) throw this.error(target, `cannot set property on ${typeOf(object)}`);
      object.set(target.name, combine(object.has(target.name) ? object.get(target.name) : null));
      return;
    }

    const index = this.eval(target.index, env);
    if (object instanceof Map) {
      if (typeof index !== 'string') throw this.error(target, 'map keys must be strings');
      object.set(index, combine(object.has(index) ? object.get(index) : null));
      return;
    }
    if (Array.isArray(object)) {
      const i = this.listIndex(object, index, target);
      object[i] = combine(object[i]);
      return;
    }
    throw this.error(target, `cannot assign to an index of ${typeOf(object)}`);
  }

  listIndex(subject, index, node) {
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      throw this.error(node, `index must be an integer, got ${show(index, true)}`);
    }
    const i = index < 0 ? subject.length + index : index;
    if (i < 0 || i >= subject.length) {
      throw this.error(node, `index ${index} out of range (length ${subject.length})`);
    }
    return i;
  }

  rangeBounds(node, env) {
    const from = this.eval(node.start, env);
    const to = this.eval(node.end, env);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw this.error(node, 'range bounds must be integers');
    }
    return [from, node.inclusive ? to + 1 : to];
  }

  evalItems(nodes, env) {
    const items = [];
    for (const item of nodes) {
      if (item.type !== 'Spread') {
        items.push(this.eval(item, env));
        continue;
      }
      const spread = this.eval(item.value, env);
      if (!Array.isArray(spread)) throw this.error(item, `cannot spread ${typeOf(spread)}`);
      for (const x of spread) items.push(x);
    }
    return items;
  }

  eval(node, env) {
    switch (node.type) {
      case 'Literal':
        return node.value;
      case 'Template':
        return node.parts.map((p) => (typeof p === 'string' ? p : show(this.eval(p, env)))).join('');
      case 'Identifier': {
        const owner = env.find(node.name);
        if (!owner) throw this.error(node, `undefined variable '${node.name}'`);
        return owner.vars.get(node.name);
      }
      case 'Function':
        return new PicoFunction(node.name, node.params, node.body, env, this.file);
      case 'List':
        return this.evalItems(node.items, env);
      case 'Map':
        return new Map(node.entries.map(({ key, value }) => [key, this.eval(value, env)]));
      case 'Range': {
        const [from, to] = this.rangeBounds(node, env);
        const items = [];
        for (let n = from; n < to; n++) items.push(n);
        return items;
      }
      case 'Ternary':
        return truthy(this.eval(node.cond, env)) ? this.eval(node.then, env) : this.eval(node.otherwise, env);
      case 'Unary':
        return this.unary(node, env);
      case 'Binary':
        return this.binary(node.op, this.eval(node.left, env), this.eval(node.right, env), node);
      case 'Logical': {
        const left = this.eval(node.left, env);
        if (node.op === 'or') return truthy(left) ? left : this.eval(node.right, env);
        return truthy(left) ? this.eval(node.right, env) : left;
      }
      case 'Call': {
        const callee = this.eval(node.callee, env);
        return this.call(callee, this.evalItems(node.args, env), node);
      }
      case 'Index':
        return this.index(this.eval(node.object, env), this.eval(node.index, env), node);
      case 'Member':
        return this.member(this.eval(node.object, env), node.name, node);
      default:
        throw this.error(node, `unknown expression '${node.type}'`);
    }
  }

  member(object, name, node) {
    if (object instanceof Instance) {
      if (object.fields.has(name)) return object.fields.get(name);
      const method = object.type.methods.get(name);
      if (method) return new BoundMethod(method, object);
      throw this.error(node, `${object.type.name} has no field or method '${name}'`);
    }
    if (object instanceof Map && object.has(name)) return object.get(name);
    const table = this.methods.get(typeOf(object));
    const builtin = table && table.get(name);
    if (builtin) return new Native(name, (args, interp) => builtin.fn([object, ...args], interp, 1));
    if (object instanceof Map) return null;
    throw this.error(node, `cannot read '${name}' of ${typeOf(object)}`);
  }

  unary(node, env) {
    const value = this.eval(node.operand, env);
    if (node.op === 'not') return !truthy(value);
    if (typeof value !== 'number') throw this.error(node, `cannot negate ${typeOf(value)}`);
    return -value;
  }

  binary(op, l, r, node) {
    switch (op) {
      case '==':
        return equals(l, r);
      case '!=':
        return !equals(l, r);
      case '+':
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        if (typeof l === 'string' || typeof r === 'string') return show(l) + show(r);
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        break;
      case '-':
        if (typeof l === 'number' && typeof r === 'number') return l - r;
        break;
      case '*':
        if (typeof l === 'number' && typeof r === 'number') return l * r;
        if (typeof l === 'string' && typeof r === 'number') {
          if (!Number.isInteger(r) || r < 0) throw this.error(node, 'repeat count must be a non-negative integer');
          return l.repeat(r);
        }
        break;
      case '/':
      case '%':
        if (typeof l === 'number' && typeof r === 'number') {
          if (r === 0) throw this.error(node, 'division by zero');
          return op === '/' ? l / r : l % r;
        }
        break;
      case '<':
      case '<=':
      case '>':
      case '>=':
        if ((typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string')) {
          if (op === '<') return l < r;
          if (op === '<=') return l <= r;
          if (op === '>') return l > r;
          return l >= r;
        }
        break;
      default:
        break;
    }
    throw this.error(node, `cannot apply '${op}' to ${typeOf(l)} and ${typeOf(r)}`);
  }

  index(subject, index, node) {
    if (Array.isArray(subject) || typeof subject === 'string') {
      return subject[this.listIndex(subject, index, node)];
    }
    if (subject instanceof Map) {
      if (typeof index !== 'string') throw this.error(node, 'map keys must be strings');
      return subject.has(index) ? subject.get(index) : null;
    }
    throw this.error(node, `cannot index ${typeOf(subject)}`);
  }

  call(fn, args, node) {
    if (fn instanceof Native) {
      try {
        return fn.fn(args, this);
      } catch (e) {
        throw this.normalize(e, node);
      }
    }
    if (fn instanceof PicoFunction) return this.callFunction(fn, args, node, 0);
    if (fn instanceof BoundMethod) return this.callFunction(fn.fn, [fn.self, ...args], node, 1);
    if (fn instanceof StructType) return this.construct(fn, args, node);
    throw this.error(node, `cannot call ${typeOf(fn)}`);
  }

  construct(type, args, node) {
    if (args.length !== type.fields.length) {
      throw this.error(node, `${type.name} expects ${type.fields.length} field value(s), got ${args.length}`);
    }
    return new Instance(type, new Map(type.fields.map((name, i) => [name, args[i]])));
  }

  callFunction(fn, args, node, offset) {
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      const min = fn.minArgs - offset;
      const max = fn.maxArgs - offset;
      let expected = `${min} to ${max}`;
      if (fn.hasRest) expected = `at least ${min}`;
      else if (min === max) expected = `${min}`;
      throw this.error(node, `${fn.name || 'function'} expects ${expected} argument(s), got ${args.length - offset}`);
    }
    if (this.depth >= this.maxDepth) throw this.error(node, 'maximum call depth exceeded');

    const scope = new Env(fn.env);
    const previousFile = this.file;
    this.file = fn.file;
    this.depth++;
    try {
      fn.params.forEach((param, i) => {
        if (param.rest) scope.define(param.name, args.slice(i));
        else if (i < args.length) scope.define(param.name, args[i]);
        else scope.define(param.name, this.eval(param.init, scope));
      });
      const signal = this.execBlock(fn.body.body, scope);
      return signal instanceof ReturnSignal ? signal.value : null;
    } finally {
      this.depth--;
      this.file = previousFile;
    }
  }
}

module.exports = { Interpreter };
