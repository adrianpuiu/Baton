// Trivial passing test suite — the CI lane's run_tests tool shells in here.
const tests = [
  { name: 'adds numbers', pass: 1 + 1 === 2 },
  { name: 'parses config', pass: JSON.parse('{"ok":true}').ok === true },
  { name: 'handles empty input', pass: [].length === 0 },
];
const failed = tests.filter((t) => !t.pass);
for (const t of tests) console.log(`${t.pass ? '\u2713' : '\u2717'} ${t.name}`);
if (failed.length) { console.error(`${failed.length} test(s) failed`); process.exit(1); }
console.log(`All ${tests.length} tests passed.`);
