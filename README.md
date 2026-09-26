# Pico

Pico is a small, dynamically typed programming language. Source files use the `.pico` extension.
The interpreter is written in plain JavaScript and needs only Node.js 18 or newer.

## Running

```
node bin/pico.js examples/hello.pico
node bin/pico.js repl
npm test
```

Run `npm link` once to get a global `pico` command:

```
pico examples/hello.pico
pico run program.pico arg1 arg2
```

Errors are reported as `file:line:col: error: message`, with no stack traces. The exit code is `1` on error.

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

let double = fn(x) { return x * 2 }

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
| `string` | `"text"`, `'text'`            |
| `bool`   | `true`, `false`               |
| `nil`    | `nil`                         |
| `list`   | `[1, "two", [3]]`             |
| `map`    | `{name: "Pico", "key": 1}`    |
| `fn`     | `fn(a, b) { return a + b }`   |

Only `false` and `nil` are falsy. Lists and maps are shared by reference. Map keys are strings.
Negative list and string indexes count from the end. Missing map keys read as `nil`.

### Operators

`+ - * / %`, `== != < <= > >=`, `and or not`, and the assignment forms `= += -= *= /= %=`.
`+` joins strings (converting the other side with `str`), concatenates lists, and adds numbers.
`"ab" * 3` repeats a string. `and` / `or` return one of their operands.

A line that starts with `(`, `[` or a binary operator is a new statement, so put an operator at the end of a line to continue an expression.

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
| `has(x, item)` | Membership for strings, lists and maps |
| `keys(map)`, `values(map)` | Map contents |
| `slice(x, from, to?)`, `reverse(x)`, `sort(list, cmp?)` | Non-mutating helpers |
| `map(list, fn)`, `filter(list, fn)`, `reduce(list, fn, init)`, `each(list, fn)` | Higher-order helpers |
| `assert(cond, message?)`, `exit(code?)` | Program control |

Modules:

| Module | Members |
| ------ | ------- |
| `math` | `pi e abs floor ceil round trunc sqrt sin cos tan log pow min max random randint` |
| `text` | `upper lower trim split join replace starts ends find repeat chars` |
| `fs`   | `read write append exists lines remove list join` |
| `os`   | `args env platform cwd` |
| `time` | `now sleep` |
| `json` | `encode decode` |

## Limits

Call depth is capped at 1000 frames, and exceeding it raises a catchable `maximum call depth exceeded` error.

## Layout

```
bin/pico.js         command line entry point and REPL
src/lexer.js        source text to tokens
src/parser.js       tokens to syntax tree
src/interpreter.js  tree-walking evaluator
src/values.js       runtime values and helpers
src/stdlib.js       built-in functions and modules
src/errors.js       error types
examples/           sample programs
tests/              test runner and .pico cases
```
