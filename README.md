<p align="center">
  <img src="assets/logo.svg" width="160" height="160" alt="Pico logo">
</p>

<h1 align="center">Pico</h1>

<p align="center">A small, fast-to-learn programming language for <code>.pico</code> files.</p>

Pico is dynamically typed, with first-class functions, structs with methods, string interpolation, pipes and a built-in standard library.
The interpreter is written in plain JavaScript and needs only Node.js 18 or newer.

## Running

```
node bin/pico.js examples/hello.pico
node bin/pico.js repl
node bin/pico.js check examples/hello.pico
npm test
```

Run `npm link` once to get a global `pico` command:

```
pico examples/hello.pico
pico run program.pico arg1 arg2
```

Errors are reported as `file:line:col: error: message`, with no stack traces. The exit code is `1` on error.
Programs run on a large stack, so recursion up to 100000 calls deep works.

## A taste of Pico

```
struct Point {
  x
  y

  fn add(self, other) {
    return Point(self.x + other.x, self.y + other.y)
  }

  fn describe(self) {
    return "({self.x}, {self.y})"
  }
}

let total = 0..=10
  |> filter(fn(n) { return n % 2 == 0 })
  |> map(fn(n) { return Point(n, n * n) })
  |> reduce(fn(acc, p) { return acc.add(p) }, Point(0, 0))

print("sum of even points: {total.describe()}")
```

## Language

Pico has no comment syntax. Statements end at a newline, and `;` is optional.

```
let name = "Pico"
let numbers = [1, 2, 3]
let person = {name: "Ada", age: 36}

person.age += 1
numbers[0] = 10

fn add(a, b) {
  return a + b
}

if add(1, 2) > 2 {
  print("big")
} else if false {
  print("never")
} else {
  print("small")
}

while true {
  break
}

for n in numbers {
  print(n)
}

for index, n in numbers {
  print(index, n)
}

for key, value in person {
  print(key, value)
}

try {
  throw "boom"
} catch e {
  print("caught", e)
}
```

### Values

| Type     | Examples                      |
| -------- | ----------------------------- |
| `number` | `1`, `3.14`                   |
| `string` | `"text"`, `'text'`, `` `raw` ``  |
| `bool`   | `true`, `false`               |
| `nil`    | `nil`                         |
| `list`   | `[1, "two", [3]]`             |
| `map`    | `{name: "Pico", "key": 1}`    |
| `fn`     | `fn(a, b) { return a + b }`   |
| struct   | `Point(1, 2)`                 |

Only `false` and `nil` are falsy. Lists, maps and struct instances are shared by reference. Map keys are strings.
Negative list and string indexes count from the end. Missing map keys read as `nil`.

### Strings

Double and single quoted strings support escapes and interpolation. Any expression can go inside `{}`, and `\{` writes a literal brace.
Backtick strings are raw: no escapes and no interpolation, which suits regular expressions.

```
let n = 3
print("{n} squared is {n * n}")
print(`\d+ stays as written`)
```

### Functions

```
fn greet(who, greeting = "Hello") {
  return "{greeting}, {who}!"
}

fn total(first, ...rest) {
  return first + sum(rest)
}

print(greet("Ada"), total(1, 2, 3))
print(total(...[1, 2, 3]))
```

Parameters can have defaults, and the last parameter can collect the remaining arguments with `...`.
`...` also spreads a list into a call or a list literal. Functions are closures.

### Structs

```
struct Counter {
  count

  fn bump(self, by = 1) {
    self.count += by
    return self
  }
}

let c = Counter(0)
c.bump().bump(5)
print(c)
```

A struct lists its fields, then its methods. Methods take `self` as their first parameter.
`Counter(0)` builds an instance from field values in order. Instances compare by value.

### Ranges, ternary and pipes

```
for i in 0..5 { print(i) }
for i in 1..=5 { print(i) }

print(n > 0 ? "positive" : "not positive")

let result = [3, 1, 2]
  |> sort
  |> map(str)
```

`a..b` excludes `b` and `a..=b` includes it. `x |> f` calls `f(x)`, and `x |> f(y)` calls `f(x, y)`.

### Methods on built-in values

Built-in functions are also available as methods on the matching type:

```
[1, 2, 3].map(fn(x) { return x * x }).sum()
"  hello ".trim().upper()
{a: 1}.keys()
```

### Operators

`+ - * / %`, `== != < <= > >=`, `and or not`, `? :`, `|>`, `..`, `..=`, and the assignment forms `= += -= *= /= %=`.
`+` joins strings (converting the other side with `str`), concatenates lists, and adds numbers.
`"ab" * 3` repeats a string. `and` / `or` return one of their operands.

A line that starts with `(`, `[` or a binary operator is a new statement, so put an operator at the end of a line to continue an expression.
A line that starts with `|>` or `.` continues the previous one.

### Modules

```
use math
use time as clock
use "lib" as lib
```

`use name` loads a built-in module. `use "path" as name` runs another `.pico` file (the `.pico` extension is optional,
and the path is relative to the importing file) and binds a map of everything it defined at the top level.

## Built-in API

Global functions:

| Function | Description |
| -------- | ----------- |
| `print(...)`, `write(...)` | Print values with or without a trailing newline |
| `input(prompt?)` | Read a line from stdin, or `nil` at end of input |
| `len(x)` | Length of a string, list or map |
| `str(x)`, `num(x)`, `type(x)` | Convert to string, parse a number (or `nil`), get the type name |
| `range(stop)`, `range(start, stop, step?)` | List of numbers |
| `push(list, x)`, `pop(list)`, `remove(list_or_map, key)` | Mutate a collection |
| `has(x, item)`, `index_of(x, item)` | Membership and position |
| `keys(map)`, `values(map)`, `entries(map)`, `from_entries(pairs)` | Map contents |
| `slice(x, from, to?)`, `reverse(x)`, `sort(list, cmp?)`, `copy(x)` | Non-mutating helpers |
| `first(list)`, `last(list)`, `flat(list)`, `unique(list)`, `zip(a, b)`, `join(list, sep?)` | List helpers |
| `map(list, fn)`, `filter(list, fn)`, `reduce(list, fn, init)`, `each(list, fn)` | Higher-order helpers |
| `find(list, fn)`, `any(list, fn?)`, `all(list, fn?)`, `sum(list)` | Searching and totals |
| `assert(cond, message?)`, `exit(code?)` | Program control |

Modules:

| Module | Members |
| ------ | ------- |
| `math` | `pi e abs floor ceil round trunc sqrt sin cos tan log pow min max random randint` |
| `text` | `upper lower trim split join replace starts ends find repeat chars lines pad_left pad_right` |
| `re`   | `test match find_all replace split` |
| `fs`   | `read write append exists lines remove list join` |
| `os`   | `args env platform cwd` |
| `time` | `now sleep` |
| `json` | `encode decode` |

## Layout

```
bin/pico.js         command line entry point, worker launcher and REPL
src/lexer.js        source text to tokens
src/parser.js       tokens to syntax tree
src/interpreter.js  tree-walking evaluator
src/values.js       runtime values and helpers
src/stdlib.js       built-in functions and modules
src/errors.js       error types
assets/logo.svg     the Pico logo
examples/           sample programs
tests/              test runner and .pico cases
```
