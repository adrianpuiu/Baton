/**
 * Resolve open-ecosystem skills for each lane of the sample process and print
 * a reviewable manifest. Hits skills.sh (online). Run: `npm run resolve:skills`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { resolveSkills } from '../src/capabilities/skill-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const dsl = readFileSync(join(root, 'src', 'samples', 'order-fulfilment.pf'), 'utf8');
const ast = parsePiperFlow(dsl);
const manifest = await resolveSkills(ast);

// Write the reviewable manifest consumed by `npm run lock:skills`.
writeFileSync(join(root, 'skills.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`→ wrote skills.manifest.json\n`);

console.log(`Process: ${manifest.process}`);
console.log(`Online: ${manifest.online} · minInstalls: ${manifest.minInstalls} · ${new Date(manifest.resolvedAt).toISOString()}`);
console.log('─'.repeat(72));
for (const lane of manifest.lanes) {
  console.log(`\n▸ ${lane.lane}${lane.pool ? ` (${lane.pool})` : ''}  —  query: "${lane.query}"  (${lane.totalCandidates} candidates)`);
  if (!lane.skills.length) {
    console.log('   (no skill met the quality threshold — lane degrades to prompting)');
    continue;
  }
  for (const s of lane.skills) {
    const badge = s.knownSource ? ' [known source]' : '';
    console.log(`   • ${s.name} — ${s.installs.toLocaleString()} installs${badge}`);
    console.log(`     ${s.addCommand}`);
  }
}
