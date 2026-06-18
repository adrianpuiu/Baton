#!/usr/bin/env node
/**
 * baton — formal soundness checking for BPMN / PiperFlow processes.
 *
 *   baton check <file.pf|file.bpmn> [--json] [--quiet]
 *
 * Exit codes (CI-friendly):
 *   0  process is sound
 *   1  process is unsound (defects found)
 *   2  usage error / could not read or parse the file
 *
 * The `check` path is deliberately lean: it imports only the parser, the BPMN
 * importer, and the soundness analyser — no Flue runtime, no HTTP, no model.
 * That keeps `npm i -g baton-bpmn` small and the tool fast to install.
 */
import { readFileSync } from 'node:fs';
import { parsePiperFlow, ParseError } from './compiler/parse.js';
import { importBpmn, BpmnImportError } from './compiler/bpmn-import.js';
import { checkSoundness } from './compiler/soundness.js';
import type { ProcessAST } from './compiler/types.js';

const VERSION = '0.1.0';

function usage(): string {
  return `baton ${VERSION} — formal soundness checking for BPMN / PiperFlow

USAGE
  baton check <file>            analyse a .pf (PiperFlow) or .bpmn (BPMN 2.0) file
  baton --version, -v           print version
  baton --help, -h              this message

CHECK OPTIONS
  --json                        emit machine-readable JSON (defects + stats)
  --quiet                       no output; rely on the exit code only

EXIT CODES
  0  sound          1  unsound (defects)          2  usage/parse error

Baton ingests any BPMN 2.0 export (Camunda / Signavio / Appian) or its own
PiperFlow DSL and tells you whether the process can deadlock, has dead
branches, or completes improperly — the formal-correctness layer most BPMN
tools don't ship. Local-first; runs offline.`;
}

interface Args {
  command: string | null;
  file: string | null;
  json: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, file: null, json: false, quiet: false };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '-h' || a === '--help') { console.log(usage()); process.exit(0); }
    if (a === '-v' || a === '--version') { console.log(VERSION); process.exit(0); }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--quiet') { args.quiet = true; continue; }
    if (a.startsWith('--')) { console.error(`unknown option: ${a}\n\n${usage()}`); process.exit(2); }
    positional.push(a);
  }
  args.command = positional[0] ?? null;
  args.file = positional[1] ?? null;
  return args;
}

/** Load a process file into an AST, auto-detecting PiperFlow vs BPMN. */
function loadProcess(file: string): ProcessAST {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`error: could not read '${file}': ${(e as Error).message}`);
    process.exit(2);
  }
  try {
    return file.toLowerCase().endsWith('.bpmn')
      ? importBpmn(src)
      : parsePiperFlow(src);
  } catch (e) {
    const kind = e instanceof ParseError ? 'parse' : e instanceof BpmnImportError ? 'import' : 'unknown';
    console.error(`error: ${kind} failed for '${file}': ${(e as Error).message}`);
    process.exit(2);
  }
}

function runCheck(args: Args): void {
  if (!args.file) { console.error(`usage: baton check <file>\n\n${usage()}`); process.exit(2); }
  const ast = loadProcess(args.file);
  const result = checkSoundness(ast);

  if (args.quiet) {
    process.exit(result.sound ? 0 : 1);
  }

  if (args.json) {
    // Machine-readable: stable shape for CI tooling / programmatic consumption.
    console.log(JSON.stringify({
      file: args.file,
      process: ast.title,
      sound: result.sound,
      stats: result.stats,
      notes: result.notes,
      defects: result.issues.map((i) => ({ kind: i.kind, elementIds: i.elementIds, message: i.message })),
    }, null, 2));
    process.exit(result.sound ? 0 : 1);
  }

  // Human-readable.
  console.log(`Process: ${ast.title}`);
  console.log(`Sound:   ${result.sound ? 'YES ✓' : 'NO ✗'}`);
  console.log(`States:  ${result.stats.markingsExplored} explored (bounded: ${result.stats.bounded})`);
  if (result.issues.length) {
    console.log(`\nDefects (${result.issues.length}):`);
    for (const i of result.issues) {
      const where = i.elementIds.length ? ` [${i.elementIds.join(', ')}]` : '';
      console.log(`  • ${i.kind}${where}\n    ${i.message}`);
    }
  }
  if (result.notes.length) {
    console.log('\nCaveats:');
    for (const n of result.notes) console.log(`  · ${n}`);
  }
  process.exit(result.sound ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
switch (args.command) {
  case 'check': runCheck(args); break;
  case null: console.error(usage()); process.exit(2);
  default: console.error(`unknown command: ${args.command}\n\n${usage()}`); process.exit(2);
}
