/**
 * BPMN 2.0 XML → ProcessAST importer.
 *
 * This is the build that turns Baton from a closed-loop tool (generate PiperFlow,
 * check PiperFlow) into an open one: ingest ANY BPMN 2.0 export — from Camunda,
 * Signavio, Appian, or Baton's own emitter — and feed it to the soundness checker
 * (and, downstream, the renderer/compiler). The loop opens the moment you can
 * point Baton at a process someone already has, not just one it produced.
 *
 * Scope (honest, for v1): extracts the control-flow structure — elements,
 * sequence flows, lanes, pools, task sub-types. That's exactly what the
 * soundness checker needs. It deliberately does NOT enforce PiperFlow's strict
 * authoring rules (single start, no orphans): real-world BPMN is messier than
 * we let authors be, and an intake tool must be permissive. The data layer
 * (ioSpec) is not reconstructed (soundness is control-flow only anyway).
 * Multi-process files (one collaboration, several participant processes) take
 * the first referenced process in v1 — flagged as a limitation.
 */

import { XMLParser } from 'fast-xml-parser';
import type { ProcessAST, ProcessElement, ElementCategory, TaskType, Lane } from './types.js';

/** BPMN element tag → our category/variant (+optional taskType). */
const ELEMENT_MAP: Record<string, { category: ElementCategory; variant: ProcessElement['variant']; taskType?: TaskType }> = {
  startEvent: { category: 'event', variant: 'start' },
  endEvent: { category: 'event', variant: 'end' },
  intermediateCatchEvent: { category: 'event', variant: 'intermediate' },
  intermediateThrowEvent: { category: 'event', variant: 'intermediate' },
  boundaryEvent: { category: 'event', variant: 'intermediate' },
  task: { category: 'activity', variant: 'task' },
  serviceTask: { category: 'activity', variant: 'task', taskType: 'service' },
  userTask: { category: 'activity', variant: 'task', taskType: 'user' },
  businessRuleTask: { category: 'activity', variant: 'task', taskType: 'businessRule' },
  sendTask: { category: 'activity', variant: 'task', taskType: 'send' },
  receiveTask: { category: 'activity', variant: 'task', taskType: 'receive' },
  manualTask: { category: 'activity', variant: 'task', taskType: 'manual' },
  scriptTask: { category: 'activity', variant: 'task', taskType: 'script' },
  subProcess: { category: 'activity', variant: 'subprocess' },
  callActivity: { category: 'activity', variant: 'subprocess' },
  transaction: { category: 'activity', variant: 'subprocess' },
  exclusiveGateway: { category: 'gateway', variant: 'exclusive' },
  parallelGateway: { category: 'gateway', variant: 'parallel' },
  inclusiveGateway: { category: 'gateway', variant: 'inclusive' },
  eventBasedGateway: { category: 'gateway', variant: 'event' },
  complexGateway: { category: 'gateway', variant: 'exclusive' }, // approximated
};

/** Coerce a fast-xml-parser node to an array (single child → [child], missing → []). */
function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Strip a BPMN namespace prefix ('bpmn:task' → 'task'). */
const localName = (qname: string): string => qname.replace(/^[^:]+:/, '');

export class BpmnImportError extends Error {}

/**
 * Parse BPMN 2.0 XML into a ProcessAST suitable for the soundness checker.
 * Throws BpmnImportError on fundamentally un-parseable input.
 */
export function importBpmn(xml: string): ProcessAST {
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      // Keep element/attribute names verbatim (namespaces matter for BPMN).
      removeNSPrefix: false,
      trimValues: true,
    }).parse(xml);
  } catch (e) {
    throw new BpmnImportError(`Could not parse XML: ${(e as Error).message}`);
  }

  const defs = (parsed as Record<string, unknown>)['bpmn:definitions'] as
    | Record<string, unknown>
    | undefined;
  if (!defs) throw new BpmnImportError('Not a BPMN file: no <bpmn:definitions> root.');

  // Collect all processes (one per pool in a collaboration, or a single process).
  const processes = asArray(defs['bpmn:process'] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (processes.length === 0) throw new BpmnImportError('No <bpmn:process> found.');

  // participant → pool name, keyed by processRef.
  const collaboration = asArray(defs['bpmn:collaboration'] as Record<string, unknown> | undefined)[0];
  const poolByProcessRef = new Map<string, string>();
  for (const p of asArray((collaboration as Record<string, unknown> | undefined)?.['bpmn:participant'] as Record<string, unknown>[] | undefined)) {
    const ref = p['@_processRef'] as string | undefined;
    const name = (p['@_name'] as string) || (p['@_id'] as string) || 'Pool';
    if (ref) poolByProcessRef.set(ref, name);
  }

  // v1 limitation: handle the first process. (Multi-process collaboration merge
  // is a real feature but out of scope for the soundness MVP.)
  const process = processes[0];
  const processId = (process['@_id'] as string) ?? 'process';
  const title = (process['@_name'] as string) ?? processId;
  const poolName = poolByProcessRef.get(processId);

  // Lane map: nodeId → lane name. Built from laneSet/lane/flowNodeRef.
  const laneOfNode = new Map<string, string>();
  const lanes: Lane[] = [];
  type XmlNode = Record<string, unknown>;
  const laneSets = asArray((process['bpmn:laneSet'] as XmlNode | XmlNode[] | undefined) ?? undefined);
  for (const ls of laneSets) {
    for (const lane of asArray((ls['bpmn:lane'] as XmlNode | XmlNode[] | undefined) ?? undefined)) {
      const laneName = (lane['@_name'] as string) ?? (lane['@_id'] as string) ?? 'Lane';
      lanes.push({ name: laneName, ...(poolName ? { pool: poolName } : {}) });
      for (const ref of asArray(lane['bpmn:flowNodeRef'] as string | string[] | undefined)) {
        laneOfNode.set(ref, laneName);
      }
    }
  }
  // If the process had no lanes, every element lands in a synthetic default lane.
  const DEFAULT_LANE = poolName ?? 'Process';
  if (lanes.length === 0) lanes.push({ name: DEFAULT_LANE, ...(poolName ? { pool: poolName } : {}) });

  // Walk the process's direct children once, partitioning by tag.
  const elements: ProcessElement[] = [];
  const knownElementIds = new Set<string>();
  for (const [key, value] of Object.entries(process)) {
    if (key.startsWith('@_')) continue; // attribute
    const tag = localName(key);
    const mapping = ELEMENT_MAP[tag];
    if (!mapping) continue; // sequenceFlow, ioSpecification, dataObject, etc. handled separately

    for (const node of asArray(value as XmlNode | XmlNode[])) {
      const id = node['@_id'] as string | undefined;
      if (!id) continue; // can't reference a node without an id
      const lane = laneOfNode.get(id) ?? DEFAULT_LANE;
      const nameAttr = node['@_name'] as string | undefined;
      const label =
        mapping.variant === 'start' || mapping.variant === 'end'
          ? mapping.variant.charAt(0).toUpperCase() + mapping.variant.slice(1)
          : (nameAttr ?? id);
      elements.push({
        id,
        label,
        lane,
        category: mapping.category,
        variant: mapping.variant,
        ...(mapping.taskType ? { taskType: mapping.taskType } : {}),
        ...(poolName ? { pool: poolName } : {}),
      });
      knownElementIds.add(id);
    }
  }

  // Sequence flows → edges. Drop refs that don't resolve to a known element
  // (dangling edges are noise for soundness; keep the structure honest).
  const edges: { from: string; to: string; label?: string }[] = [];
  for (const sf of asArray((process['bpmn:sequenceFlow'] as XmlNode | XmlNode[] | undefined) ?? undefined)) {
    const from = sf['@_sourceRef'] as string | undefined;
    const to = sf['@_targetRef'] as string | undefined;
    if (!from || !to) continue;
    if (!knownElementIds.has(from) || !knownElementIds.has(to)) continue;
    const name = sf['@_name'] as string | undefined;
    edges.push({ from, to, ...(name ? { label: name } : {}) });
  }

  return {
    title,
    lanes,
    elements,
    edges,
    dataObjects: [], // control-flow import only; data layer out of scope for v1
  };
}
