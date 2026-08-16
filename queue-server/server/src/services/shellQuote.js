// POSIX single-quote shell escaping for values interpolated into a `bash -c`
// command string. Every value that reaches a shell string (model name, effort,
// session id, bin path, file paths) must go through this — a value wrapped in
// single quotes cannot break out of the quoting no matter what characters it
// contains, since the only character that has meaning inside single quotes is
// another single quote, which this escapes to '\'' (close quote, escaped quote,
// reopen quote).
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
