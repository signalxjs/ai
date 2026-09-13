// Prints its arguments as JSON — for argument-fidelity tests.
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\n');
