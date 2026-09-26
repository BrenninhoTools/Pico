class PicoError extends Error {
  constructor(message, pos = {}, value) {
    super(message);
    this.name = 'PicoError';
    this.file = pos.file;
    this.line = pos.line;
    this.col = pos.col;
    this.value = value === undefined ? message : value;
  }

  format() {
    if (this.line === undefined) {
      return `error: ${this.message}`;
    }
    return `${this.file}:${this.line}:${this.col}: error: ${this.message}`;
  }
}

class ExitSignal {
  constructor(code) {
    this.code = code;
  }
}

module.exports = { PicoError, ExitSignal };
