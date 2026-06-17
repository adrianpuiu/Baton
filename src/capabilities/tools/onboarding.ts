import { defineTool, type ToolParameters } from '@flue/runtime';
import { createRecord, appendEvent } from './audit-trail.js';

// Each tool simulates a real provisioning system (HRIS, MDM, Okta, badge, calendar)
// and appends a timestamped event to the employee's persistent audit trail.

export const createEmployeeRecordTool = defineTool({
  name: 'create_employee_record',
  description: 'Create a new employee record in the HRIS. Call this FIRST — it returns an employee_id that every later onboarding step needs. Writes the initial audit-trail entry.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Full name of the new hire' },
      email: { type: 'string' },
      role: { type: 'string' },
      start_date: { type: 'string', description: 'ISO date, e.g. 2026-07-01' },
    },
    required: ['name', 'role'],
  } satisfies ToolParameters,
  async execute({ name, email, role, start_date }) {
    const rec = await createRecord({
      name: name ?? 'New Hire',
      email: email ?? `${String(name ?? 'hire').toLowerCase().replace(/\s+/g, '.')}@example.com`,
      role: role ?? 'Employee',
      start_date: start_date ?? new Date().toISOString().slice(0, 10),
    });
    return JSON.stringify({ employee_id: rec.employee_id, status: rec.status, name: rec.name, audit: `employees/${rec.employee_id}.json` });
  },
});

export const initiateBackgroundCheckTool = defineTool({
  name: 'initiate_background_check',
  description: 'Run a background check for an employee. Returns passed:true by default (happy path) unless force_fail is set. Records the result on the audit trail.',
  parameters: {
    type: 'object',
    properties: { employee_id: { type: 'string' }, force_fail: { type: 'boolean' } },
    required: ['employee_id'],
  } satisfies ToolParameters,
  async execute({ employee_id, force_fail }) {
    const passed = !force_fail;
    const rec = await appendEvent(employee_id, 'background_check', 'HR', { passed, provider: 'Checkr (simulated)' }, { status: passed ? 'bg_passed' : 'bg_failed' });
    return JSON.stringify({ employee_id, passed, status: rec.status });
  },
});

export const finalizePaperworkTool = defineTool({
  name: 'finalize_paperwork',
  description: 'Finalize onboarding paperwork and mark the employee active. Call after all day-one provisioning is complete.',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id }) {
    const rec = await appendEvent(employee_id, 'paperwork_finalized', 'HR', {}, { status: 'active' });
    return JSON.stringify({ employee_id, status: rec.status, onboarding: 'complete' });
  },
});

export const revokeAccessTool = defineTool({
  name: 'revoke_access',
  description: 'Revoke all access and terminate employment. Used when a background check fails.',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' }, reason: { type: 'string' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id, reason }) {
    const rec = await appendEvent(employee_id, 'access_revoked', 'HR', { reason: reason ?? 'background check failed' }, { status: 'terminated' });
    return JSON.stringify({ employee_id, status: rec.status });
  },
});

export const provisionLaptopTool = defineTool({
  name: 'provision_laptop',
  description: 'Order and provision a laptop for the employee (simulated MDM / Jamf). Returns an asset tag.',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' }, model: { type: 'string' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id, model }) {
    const asset = `LT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const rec = await appendEvent(employee_id, 'laptop_provisioned', 'IT', { asset_tag: asset, model: model ?? 'MacBook Pro 14" (simulated)' });
    return JSON.stringify({ employee_id, asset_tag: asset, status: rec.status });
  },
});

export const createAccountsTool = defineTool({
  name: 'create_accounts',
  description: 'Provision email and SSO accounts (simulated Okta / Google Workspace).',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' }, systems: { type: 'string', description: 'comma-separated systems' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id, systems }) {
    const sys = (systems ?? 'email, sso, slack').split(',').map((s: string) => s.trim());
    const rec = await appendEvent(employee_id, 'accounts_created', 'IT', { systems: sys });
    return JSON.stringify({ employee_id, systems: sys, status: rec.status });
  },
});

export const grantBuildingAccessTool = defineTool({
  name: 'grant_building_access',
  description: 'Issue a building access badge (simulated physical access system). Returns a badge id.',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' }, site: { type: 'string' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id, site }) {
    const badge = `BG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const rec = await appendEvent(employee_id, 'badge_issued', 'Facilities', { badge, site: site ?? 'HQ' });
    return JSON.stringify({ employee_id, badge, status: rec.status });
  },
});

export const setupDeskTool = defineTool({
  name: 'setup_desk',
  description: 'Assign and set up a desk/workspace.',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id }) {
    const desk = `D-${Math.floor(100 + Math.random() * 900)}`;
    const rec = await appendEvent(employee_id, 'desk_assigned', 'Facilities', { desk });
    return JSON.stringify({ employee_id, desk, status: rec.status });
  },
});

export const scheduleOrientationTool = defineTool({
  name: 'schedule_orientation',
  description: 'Schedule the new-hire orientation in the calendar (simulated).',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' }, day: { type: 'string' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id, day }) {
    const when = day ?? 'first Monday';
    const rec = await appendEvent(employee_id, 'orientation_scheduled', 'Manager', { day: when });
    return JSON.stringify({ employee_id, orientation: when, status: rec.status });
  },
});

export const assignBuddyTool = defineTool({
  name: 'assign_buddy',
  description: 'Assign an onboarding buddy to the new hire.',
  parameters: { type: 'object', properties: { employee_id: { type: 'string' }, buddy: { type: 'string' } }, required: ['employee_id'] } satisfies ToolParameters,
  async execute({ employee_id, buddy }) {
    const b = buddy ?? 'Senior team member (auto-assigned)';
    const rec = await appendEvent(employee_id, 'buddy_assigned', 'Manager', { buddy: b });
    return JSON.stringify({ employee_id, buddy: b, status: rec.status });
  },
});
