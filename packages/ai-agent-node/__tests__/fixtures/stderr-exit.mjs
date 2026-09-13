// Writes to stderr and exits with the given code — for stderr-tail tests.
const [code = '1', ...words] = process.argv.slice(2);
process.stderr.write(words.join(' ') + '\n', () => process.exit(Number(code)));
