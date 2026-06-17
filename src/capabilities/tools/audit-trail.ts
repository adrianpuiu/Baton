import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A persistent employee audit trail — what a real HRIS/provisioning system
 * leaves behind. Each onboarding tool appends a timestamped event to
 * `employees/<employee_id>.json`, so a live run produces a real artifact you
 * can point at: "here's the record the process built, step by step."
 */
const BASE = process.env.EMPLOYEE_DIR ?? join(process.cwd(), 'employees');

export interface AuditEvent {
  ts: string;
  action: string;
  lane: string;
  details?: Record<string, unknown>;
}

export interface EmployeeRecord {
  employee_id: string;
  name: string;
  email: string;
  role: string;
  start_date: string;
  status: string;
  events: AuditEvent[];
}

export async function loadRecord(id: string): Promise<EmployeeRecord | null> {
  try {
    return JSON.parse(await readFile(join(BASE, `${id}.json`), 'utf-8')) as EmployeeRecord;
  } catch {
    return null;
  }
}

export async function createRecord(data: {
  name: string; email: string; role: string; start_date: string;
}): Promise<EmployeeRecord> {
  const id = `EMP-${Date.now().toString(36).toUpperCase()}`;
  const rec: EmployeeRecord = {
    employee_id: id,
    name: data.name, email: data.email, role: data.role, start_date: data.start_date,
    status: 'created',
    events: [{ ts: new Date().toISOString(), action: 'record_created', lane: 'HR', details: { ...data } }],
  };
  await mkdir(BASE, { recursive: true });
  await writeFile(join(BASE, `${id}.json`), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

export async function appendEvent(
  id: string,
  action: string,
  lane: string,
  details?: Record<string, unknown>,
  patch?: Partial<EmployeeRecord>,
): Promise<EmployeeRecord> {
  const rec = await loadRecord(id);
  if (!rec) throw new Error(`employee ${id} not found — create the record first`);
  const updated: EmployeeRecord = {
    ...rec,
    ...patch,
    events: [...rec.events, { ts: new Date().toISOString(), action, lane, ...(details ? { details } : {}) }],
  };
  await mkdir(BASE, { recursive: true });
  await writeFile(join(BASE, `${id}.json`), JSON.stringify(updated, null, 2) + '\n');
  return updated;
}
