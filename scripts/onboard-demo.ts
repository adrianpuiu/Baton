/**
 * Drive the onboarding tools end-to-end (no model) to prove the full happy path
 * and produce a complete employee audit trail. Run: `npm run onboard:demo`
 */
import { readFileSync } from 'node:fs';
import {
  createEmployeeRecordTool, initiateBackgroundCheckTool,
  provisionLaptopTool, createAccountsTool,
  grantBuildingAccessTool, setupDeskTool,
  scheduleOrientationTool, assignBuddyTool,
  finalizePaperworkTool,
} from '../src/capabilities/tools/index.js';

const parse = (s: string) => JSON.parse(s);

// HR
const r = parse(await createEmployeeRecordTool.execute({ name: 'Jane Smith', email: 'jane.smith@company.com', role: 'Software Engineer', start_date: '2026-07-01' }));
const emp = r.employee_id as string;
console.log(`HR: created ${emp}`);
await initiateBackgroundCheckTool.execute({ employee_id: emp });
console.log('HR: background check passed');

// Day-one parallel branches (IT / Facilities / Manager) — run sequentially here
console.log('— day-one provisioning fan-out —');
await provisionLaptopTool.execute({ employee_id: emp });
await createAccountsTool.execute({ employee_id: emp });
console.log('IT: laptop + accounts provisioned');
await grantBuildingAccessTool.execute({ employee_id: emp });
await setupDeskTool.execute({ employee_id: emp });
console.log('Facilities: badge + desk assigned');
await scheduleOrientationTool.execute({ employee_id: emp });
await assignBuddyTool.execute({ employee_id: emp });
console.log('Manager: orientation + buddy assigned');

// HR finalize
await finalizePaperworkTool.execute({ employee_id: emp });
console.log(`HR: paperwork finalized → employee active\n`);

// Show the complete audit trail
const record = JSON.parse(readFileSync(`employees/${emp}.json`, 'utf-8'));
console.log(`=== audit trail: ${emp} (${record.name}) — status: ${record.status} ===`);
for (const e of record.events) console.log(`  ${e.ts}  ${e.action.padEnd(22)} [${e.lane}]`);
