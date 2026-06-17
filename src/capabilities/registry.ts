import type { ToolDefinition, Skill } from '@flue/runtime';
import {
  runTestsTool, buildTool, deployTool,
  createEmployeeRecordTool, initiateBackgroundCheckTool, finalizePaperworkTool, revokeAccessTool,
  provisionLaptopTool, createAccountsTool,
  grantBuildingAccessTool, setupDeskTool,
  scheduleOrientationTool, assignBuddyTool,
} from './tools/index.js';
import { securityScan } from './skills.js';

export interface Capabilities {
  tools: ToolDefinition[];
  skills: Skill[];
}

/**
 * The platform layer: bind capabilities (Flue tools + skills) to a swimlane by
 * inferring them from the lane's name. A CI lane gets `run_tests`/`build`; an
 * Ops lane gets `deploy`; a Security lane gets the security-scan skill.
 *
 * This is name-based inference for the demo. In production this would be an
 * explicit registry keyed by role (so "CI System" deterministically means the
 * test/build toolkit) — but inference shows the idea: a lane IS its toolkit.
 */
export function capabilitiesFor(laneKey: string): Capabilities {
  const k = laneKey.toLowerCase();
  const tools: ToolDefinition[] = [];
  const skills: Skill[] = [];

  if (/(ci|test|build|pipeline|integration|qa|quality)/.test(k)) tools.push(runTestsTool, buildTool);
  if (/(deploy|ops|release|publish|infra|sre|devops|delivery)/.test(k)) tools.push(deployTool);
  if (/(secur|vuln|threat)/.test(k)) skills.push(securityScan);

  // Onboarding roles — word-boundary matches for short tokens (hr/it/manager)
  // so they don't collide with substrings of other lane names.
  if (/(^|_)hr($|_)|people|human_?resources/.test(k)) tools.push(createEmployeeRecordTool, initiateBackgroundCheckTool, finalizePaperworkTool, revokeAccessTool);
  if (/(^|_)it($|_)|infrastructure|^tech|systems/.test(k)) tools.push(provisionLaptopTool, createAccountsTool);
  if (/facilit|office|building|premises|workplace/.test(k)) tools.push(grantBuildingAccessTool, setupDeskTool);
  if (/(^|_)manager($|_)|^lead$|supervisor/.test(k)) tools.push(scheduleOrientationTool, assignBuddyTool);

  return { tools, skills };
}
