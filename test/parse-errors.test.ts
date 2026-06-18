/**
 * Parser error-handling tests.
 *
 * A compiler is only as good as its rejection messages: precise, structured
 * errors are what let the self-healing generation loop feed the exact defect
 * back to the model. These pin every documented failure mode so a regression
 * that turns a clear ParseError into a cryptic crash is caught immediately.
 *
 * Run:  node --import tsx --test test/parse-errors.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiperFlow, ParseError } from '../src/compiler/parse.js';

// Helper: assert that a DSL string is rejected with a ParseError whose message
// mentions the given needle. Matching on a substring (not the exact string)
// keeps these resilient to wording polish while still pinning the failure mode.
function assertRejected(dsl: string, needle: string, label: string): void {
  assert.throws(
    () => parsePiperFlow(dsl),
    (err: unknown) => {
      assert.ok(err instanceof ParseError, `${label}: should throw ParseError`);
      const msg = (err as Error).message;
      assert.ok(
        msg.toLowerCase().includes(needle.toLowerCase()),
        `${label}: expected message to mention "${needle}", got: ${msg}`,
      );
      return true;
    },
    `${label}: expected a ParseError`,
  );
}

test('rejects: process with no start event', () => {
  // Two connected tasks, but no (start) — must be rejected.
  const dsl = `title: no start
lane: A
[First] as t1
[Second] as t2
t1 -> t2`;
  assertRejected(dsl, 'start', 'missing start');
});

test('rejects: more than one start event', () => {
  const dsl = `title: two starts
lane: A
(start) as s1
(start) as s2
(end) as e1
s1 -> s2
s2 -> e1`;
  assertRejected(dsl, 'start', 'duplicate start');
});

test('rejects: edge references an unknown element', () => {
  const dsl = `title: dangling edge
lane: A
(start) as s
(end) as e
s -> ghost`;
  assertRejected(dsl, 'ghost', 'dangling edge target');
});

test('rejects: declared-but-unconnected (orphan) element', () => {
  // 'orphan' is never wired into any edge — the validator must catch it and
  // name it, which is exactly what the self-healing loop needs to act on.
  const dsl = `title: orphan
lane: A
(start) as s
(end) as e
[Lonely] as orphan
s -> e`;
  assertRejected(dsl, 'orphan', 'orphan element');
});

test('rejects: unknown element marker', () => {
  const dsl = `title: bad marker
lane: A
(start) as s
(@bogus Thing) as t
(end) as e
s -> t -> e`;
  assertRejected(dsl, 'bogus', 'unknown marker');
});

test('rejects: element declared before any lane', () => {
  const dsl = `title: no lane yet
(start) as s`;
  assertRejected(dsl, 'lane', 'element before lane');
});
