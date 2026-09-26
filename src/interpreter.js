const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');
const { PicoError, ExitSignal } = require('./errors');
const { createLibrary } = require('./stdlib');
const { Env, PicoFunction, Native, typeOf, show, equals, truthy } = require('./values');

const MAX_DEPTH = 1000;
const BREAK = { kind: 'break' };
const CONTINUE = { kind: 'continue' };

class ReturnSignal {
  constructor(value) {
    this.kind = 'return';
    this.value = value;
  }
}

class Interpreter {
  constructor({ args = [], out = (text) => process.stdout.write(text) } = {}) {
    const library = createLibrary(out, args);
    this.globals = new Env();
    for (const [name, value] of library.globals) this.globals.define(name, value);
    this.builtinModules = library.modules;
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

  runFile(filePath, env = new Env(this.globals)) {
    const resolved = path.resolve(filePath);
    let source;
    try {
      source = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw new PicoError(`cannot read '${filePath}': ${e.code || e.message}`);
    }
    return this.runSource(source, resolved, env);
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
      case 'Throw': {
        const value = this.eval(node.value, env);
        throw new PicoError(show(value), { file: this.file, line: node.line, col: node.col }, value);
      }
      default:
        throw this.error(node, `unknown statement '${node.type}'`);
    }
  }

  execWhile(node, env) {
    while (truthy(this.eval(node.cond, env))) {
      const signal = this.execBlock(node.body.body, new Env(env));
      if (signal === BREAK) break;
      if (signal && signal !== CONTINUE) return signal;
    }
    return undefined;
  }

  execFor(node, env) {
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
    const single = node.second === null;
    const isSequence = !(subject instanceof Map);
    for (const [key, item] of entries) {
      const scope = new Env(env);
      if (single) {
        scope.define(node.first, isSequence ? item : key);
      } else {
        scope.define(node.first, key);
        scope.define(node.second, item);
      }
      const signal = this.execBlock(node.body.body, scope);
      if (signal === BREAK) break;
      if (signal && signal !== CONTINUE) return signal;
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

  eval(node, env) {
    switch (node.type) {
      case 'Literal':
        return node.value;
      case 'Identifier': {
        const owner = env.find(node.name);
        if (!owner) throw this.error(node, `undefined variable '${node.name}'`);
        return owner.vars.get(node.name);
      }
      case 'Function':
        return new PicoFunction(node.name, node.params, node.body, env, this.file);
      case 'List':
        return node.items.map((item) => this.eval(item, env));
      case 'Map':
        return new Map(node.entries.map(({ key, value }) => [key, this.eval(value, env)]));
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
        const args = node.args.map((arg) => this.eval(arg, env));
        return this.call(callee, args, node);
      }
      case 'Index':
        return this.index(this.eval(node.object, env), this.eval(node.index, env), node);
      case 'Member': {
        const object = this.eval(node.object, env);
        if (!(object instanceof Map)) throw this.error(node, `cannot read '${node.name}' of ${typeOf(object)}`);
        return object.has(node.name) ? object.get(node.name) : null;
      }
      default:
        throw this.error(node, `unknown expression '${node.type}'`);
    }
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
    if (!(fn instanceof PicoFunction)) {
      throw this.error(node, `cannot call ${typeOf(fn)}`);
    }
    if (args.length !== fn.params.length) {
      throw this.error(node, `${fn.name || 'function'} expects ${fn.params.length} argument(s), got ${args.length}`);
    }
    if (this.depth >= MAX_DEPTH) throw this.error(node, 'maximum call depth exceeded');

    const scope = new Env(fn.env);
    fn.params.forEach((name, i) => scope.define(name, args[i]));
    const previousFile = this.file;
    this.file = fn.file;
    this.depth++;
    try {
      const signal = this.execBlock(fn.body.body, scope);
      return signal instanceof ReturnSignal ? signal.value : null;
    } finally {
      this.depth--;
      this.file = previousFile;
    }
  }
}

module.exports = { Interpreter };
