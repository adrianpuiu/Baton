// Produces a real artifact the build tool can report.
const { mkdirSync, writeFileSync } = require('node:fs');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/artifact.txt', 'sample-repo build artifact\n');
console.log('Build complete: dist/artifact.txt');
