const { PicoError } = require('./errors');
const { tokenize } = require('./lexer');

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const ASSIGNABLE = new Set(['Identifier', 'Index', 'Member']);
const EQUALITY = new Set(['==', '!=']);
const COMPARISON = new Set(['<', '<=', '>', '>=']);
const ADDITIVE = new Set(['+', '-']);
const MULTIPLICATIVE = new Set(['*', '/', '%']);

const node = (type, tok, props) => ({ type, line: tok.line, col: tok.col, ...props });

class Parser {
  constructor(tokens, file) {
    this.tokens = tokens;
    this.file = file;
    this.pos = 0;
    this.loopDepth = 0;
    this.fnDepth = 0;
  }

  get tok() {
    return this.tokens[this.pos];
  }

  fail(message, tok = this.tok) {
    throw new PicoError(message, { file: this.file, line: tok.line, col: tok.col });
  }

  describe(tok) {
    if (tok.type === 'eof') return 'end of file';
    if (tok.type === 'string') return 'string';
    if (tok.type === 'number') return 'number';
    if (tok.type === 'ident') return `identifier '${tok.value}'`;
    return `'${tok.value}'`;
  }

  is(type, value) {
    const t = this.tok;
    return t.type === type && (value === undefined || t.value === value);
  }

  isOp(value) {
    return this.is('op', value);
  }

  isKeyword(value) {
    return this.is('keyword', value);
  }

  take() {
    return this.tokens[this.pos++];
  }

  accept(type, value) {
    return this.is(type, value) ? this.take() : null;
  }

  expect(type, value) {
    if (!this.is(type, value)) {
      const wanted = value === undefined ? type : `'${value}'`;
      this.fail(`expected ${wanted}, found ${this.describe(this.tok)}`);
    }
    return this.take();
  }

  skipSemicolons() {
    while (this.accept('op', ';')) {
      continue;
    }
  }

  program() {
    const body = [];
    this.skipSemicolons();
    while (!this.is('eof')) {
      body.push(this.statement());
      this.skipSemicolons();
    }
    return { type: 'Program', body };
  }

  block() {
    const open = this.expect('op', '{');
    const body = [];
    this.skipSemicolons();
    while (!this.isOp('}')) {
      if (this.is('eof')) this.fail("expected '}', found end of file");
      body.push(this.statement());
      this.skipSemicolons();
    }
    this.expect('op', '}');
    return node('Block', open, { body });
  }

  statement() {
    const t = this.tok;
    if (t.type === 'keyword') {
      switch (t.value) {
        case 'let':
          return this.letStatement();
        case 'fn':
          if (this.tokens[this.pos + 1].type === 'ident') return this.functionDeclaration();
          break;
        case 'return':
          return this.returnStatement();
        case 'if':
          return this.ifStatement();
        case 'while':
          return this.whileStatement();
        case 'for':
          return this.forStatement();
        case 'break':
        case 'continue':
          return this.jumpStatement();
        case 'use':
          return this.useStatement();
        case 'try':
          return this.tryStatement();
        case 'throw':
          return node('Throw', this.take(), { value: this.expression() });
        default:
          break;
      }
    }
    if (this.isOp('{')) return this.block();
    return this.simpleStatement();
  }

  letStatement() {
    const t = this.take();
    const name = this.expect('ident');
    this.expect('op', '=');
    return node('Let', t, { name: name.value, value: this.expression() });
  }

  functionDeclaration() {
    const t = this.take();
    const name = this.expect('ident');
    const fn = this.functionRest(t, name.value);
    return node('Let', t, { name: name.value, value: fn });
  }

  functionRest(t, name) {
    const params = this.params();
    const savedLoop = this.loopDepth;
    this.loopDepth = 0;
    this.fnDepth++;
    const body = this.block();
    this.fnDepth--;
    this.loopDepth = savedLoop;
    return node('Function', t, { name, params, body });
  }

  params() {
    this.expect('op', '(');
    const params = [];
    if (!this.isOp(')')) {
      do {
        const p = this.expect('ident');
        if (params.includes(p.value)) this.fail(`duplicate parameter '${p.value}'`, p);
        params.push(p.value);
      } while (this.accept('op', ','));
    }
    this.expect('op', ')');
    return params;
  }

  returnStatement() {
    const t = this.take();
    if (this.fnDepth === 0) this.fail("'return' outside of a function", t);
    let value = null;
    if (!this.tok.newline && !this.isOp('}') && !this.isOp(';') && !this.is('eof')) {
      value = this.expression();
    }
    return node('Return', t, { value });
  }

  ifStatement() {
    const t = this.take();
    const cond = this.expression();
    const then = this.block();
    let otherwise = null;
    if (this.accept('keyword', 'else')) {
      otherwise = this.isKeyword('if') ? this.ifStatement() : this.block();
    }
    return node('If', t, { cond, then, otherwise });
  }

  loopBody() {
    this.loopDepth++;
    const body = this.block();
    this.loopDepth--;
    return body;
  }

  whileStatement() {
    const t = this.take();
    const cond = this.expression();
    return node('While', t, { cond, body: this.loopBody() });
  }

  forStatement() {
    const t = this.take();
    const first = this.expect('ident').value;
    let second = null;
    if (this.accept('op', ',')) {
      second = this.expect('ident').value;
      if (second === first) this.fail(`duplicate loop variable '${first}'`);
    }
    this.expect('keyword', 'in');
    const iterable = this.expression();
    return node('For', t, { first, second, iterable, body: this.loopBody() });
  }

  jumpStatement() {
    const t = this.take();
    if (this.loopDepth === 0) this.fail(`'${t.value}' outside of a loop`, t);
    return node(t.value === 'break' ? 'Break' : 'Continue', t, {});
  }

  useStatement() {
    const t = this.take();
    if (this.is('string')) {
      const source = this.take().value;
      this.expect('keyword', 'as');
      const name = this.expect('ident').value;
      return node('Use', t, { source, isFile: true, name });
    }
    const id = this.expect('ident');
    const name = this.accept('keyword', 'as') ? this.expect('ident').value : id.value;
    return node('Use', t, { source: id.value, isFile: false, name });
  }

  tryStatement() {
    const t = this.take();
    const body = this.block();
    this.expect('keyword', 'catch');
    const name = this.expect('ident').value;
    const handler = this.block();
    return node('Try', t, { body, name, handler });
  }

  simpleStatement() {
    const start = this.tok;
    const expr = this.expression();
    if (this.tok.type === 'op' && ASSIGN_OPS.has(this.tok.value)) {
      const op = this.take();
      if (!ASSIGNABLE.has(expr.type)) this.fail('invalid assignment target', op);
      return node('Assign', op, { target: expr, op: op.value, value: this.expression() });
    }
    return node('ExprStmt', start, { expr });
  }

  expression() {
    return this.orExpression();
  }

  orExpression() {
    let left = this.andExpression();
    while (this.isKeyword('or')) {
      const t = this.take();
      left = node('Logical', t, { op: 'or', left, right: this.andExpression() });
    }
    return left;
  }

  andExpression() {
    let left = this.notExpression();
    while (this.isKeyword('and')) {
      const t = this.take();
      left = node('Logical', t, { op: 'and', left, right: this.notExpression() });
    }
    return left;
  }

  notExpression() {
    if (this.isKeyword('not')) {
      const t = this.take();
      return node('Unary', t, { op: 'not', operand: this.notExpression() });
    }
    return this.binaryLevel(EQUALITY, () => this.binaryLevel(COMPARISON, () => this.binaryLevel(ADDITIVE, () => this.binaryLevel(MULTIPLICATIVE, () => this.unary()))));
  }

  binaryLevel(ops, next) {
    let left = next();
    while (this.tok.type === 'op' && ops.has(this.tok.value) && !this.tok.newline) {
      const t = this.take();
      left = node('Binary', t, { op: t.value, left, right: next() });
    }
    return left;
  }

  unary() {
    if (this.isOp('-')) {
      const t = this.take();
      return node('Unary', t, { op: '-', operand: this.unary() });
    }
    return this.postfix();
  }

  postfix() {
    let expr = this.primary();
    for (;;) {
      const t = this.tok;
      if (t.type !== 'op') break;
      if (t.value === '(' && !t.newline) {
        this.take();
        const args = [];
        if (!this.isOp(')')) {
          do {
            args.push(this.expression());
          } while (this.accept('op', ','));
        }
        this.expect('op', ')');
        expr = node('Call', t, { callee: expr, args });
      } else if (t.value === '[' && !t.newline) {
        this.take();
        const index = this.expression();
        this.expect('op', ']');
        expr = node('Index', t, { object: expr, index });
      } else if (t.value === '.') {
        this.take();
        const name = this.expect('ident');
        expr = node('Member', t, { object: expr, name: name.value });
      } else {
        break;
      }
    }
    return expr;
  }

  primary() {
    const t = this.tok;
    switch (t.type) {
      case 'number':
      case 'string':
        this.take();
        return node('Literal', t, { value: t.value });
      case 'ident':
        this.take();
        return node('Identifier', t, { name: t.value });
      case 'keyword':
        if (t.value === 'true' || t.value === 'false') {
          this.take();
          return node('Literal', t, { value: t.value === 'true' });
        }
        if (t.value === 'nil') {
          this.take();
          return node('Literal', t, { value: null });
        }
        if (t.value === 'fn') {
          this.take();
          return this.functionRest(t, null);
        }
        break;
      case 'op':
        if (t.value === '(') {
          this.take();
          const inner = this.expression();
          this.expect('op', ')');
          return inner;
        }
        if (t.value === '[') return this.listLiteral();
        if (t.value === '{') return this.mapLiteral();
        break;
      default:
        break;
    }
    return this.fail(`unexpected ${this.describe(t)}`);
  }

  listLiteral() {
    const t = this.take();
    const items = [];
    while (!this.isOp(']')) {
      items.push(this.expression());
      if (!this.accept('op', ',')) break;
    }
    this.expect('op', ']');
    return node('List', t, { items });
  }

  mapLiteral() {
    const t = this.take();
    const entries = [];
    while (!this.isOp('}')) {
      const keyTok = this.tok;
      if (keyTok.type !== 'ident' && keyTok.type !== 'string') {
        this.fail(`expected map key, found ${this.describe(keyTok)}`);
      }
      this.take();
      this.expect('op', ':');
      entries.push({ key: keyTok.value, value: this.expression() });
      if (!this.accept('op', ',')) break;
    }
    this.expect('op', '}');
    return node('Map', t, { entries });
  }
}

function parse(source, file) {
  return new Parser(tokenize(source, file), file).program();
}

module.exports = { parse };
