/**
 * The PiperFlow AST.
 *
 * The DSL is the single source of truth. Consumers of this AST:
 *   - render  → PNG / SVG / BPMN-XML (via processpiper + the direct AST emitter)
 *   - compile → a runnable Flue workflow (lanes→agents, tasks→calls,
 *               gateways→ conditional / parallel branches)
 *
 * Element taxonomy follows the official ProcessPiper grammar:
 *   events    : start, end, timer, intermediate, message, signal, conditional, link
 *   activities: task (default), subprocess
 *   gateways  : exclusive (default), parallel, inclusive, event
 *
 * The data layer (DataObject + ProcessElement.ioSpec) is the seed of
 * BPMN Executable conformance: it carries what each task consumes/produces so
 * the BPMN emitter can produce ioSpecification + data associations, and so a
 * future runtime evaluator can self-assemble behaviour against process data
 * (the SAIL move).
 */

export type ElementCategory = 'event' | 'activity' | 'gateway';
export type EventVariant =
  | 'start' | 'end' | 'timer' | 'intermediate'
  | 'message' | 'signal' | 'conditional' | 'link';
export type ActivityVariant = 'task' | 'subprocess';
export type GatewayVariant = 'exclusive' | 'parallel' | 'inclusive' | 'event';

/**
 * BPMN Task sub-types ( OMG metamodel: Task has these implementations).
 * 'none' = a plain <task> with no specific implementation declared.
 * Only meaningful when an activity's variant is 'task' (subprocess has none).
 */
export type TaskType =
  | 'none' | 'service' | 'user' | 'businessRule'
  | 'send' | 'receive' | 'manual' | 'script';

export interface ProcessElement {
  id: string;
  label: string;
  lane: string;
  pool?: string;
  category: ElementCategory;
  variant: EventVariant | ActivityVariant | GatewayVariant;
  /**
   * BPMN Task sub-type (service/user/businessRule/send/receive/manual/script).
   * Declarative "how": what kind of work this step is. The renderer maps it to
   * the correct BPMN tag; the compiler maps it to the right executor pattern
   * (service→tool, user→HITL, manual→no-op, ...). Only set when variant==='task'.
   */
  taskType?: TaskType;
  /**
   * Data I/O spec — only meaningful on activities (BPMN ioSpecification).
   * The declarative "what": what data this task consumes and produces. Inputs/
   * outputs are names of declared DataObjects. This is the data layer that makes
   * emitted BPMN Executable-conformance rather than merely Descriptive, and the
   * seed of a runtime evaluator (the SAIL move): gateways can evaluate against
   * it, multi-instance can fan out over it.
   */
  ioSpec?: { inputs: string[]; outputs: string[] };
}

/** A process-level data artifact (BPMN dataObject) with an optional type. */
export interface DataObject {
  id: string;
  /** BPMN structureRef / itemDefinition type. Untyped data objects are valid. */
  type?: string;
}

export interface Lane {
  name: string;
  pool?: string;
}

export interface Edge {
  from: string;
  to: string;
  label?: string;
}

export interface ProcessAST {
  title: string;
  theme?: string;
  width?: number;
  footer?: string;
  lanes: Lane[];
  elements: ProcessElement[];
  edges: Edge[];
  /** Declared data artifacts (BPMN dataObjects). Drives ioSpecification + associations. */
  dataObjects: DataObject[];
}

/** Convenience guards used by the compiler and executor. */
export const isStart = (e: ProcessElement): boolean => e.category === 'event' && e.variant === 'start';
export const isEnd = (e: ProcessElement): boolean => e.category === 'event' && e.variant === 'end';
export const isGateway = (e: ProcessElement): boolean => e.category === 'gateway';
export const isTask = (e: ProcessElement): boolean => e.category === 'activity' && e.variant === 'task';
export const isParallel = (e: ProcessElement): boolean => e.category === 'gateway' && e.variant === 'parallel';

/**
 * Resolved data associations for a process: each activity I/O reference links a
 * declared DataObject to the activity's dataInput/dataOutput. This is the BPMN
 * dataInputAssociation / dataOutputAssociation structure, derived from ioSpec.
 */
export interface DataAssociation {
  activityId: string;
  /** 'input' = object flows INTO the activity; 'output' = object flows OUT. */
  direction: 'input' | 'output';
  dataObject: string;
}

/**
 * Derive the BPMN data associations (dataInputAssociation / dataOutputAssociation)
 * from every activity's ioSpec. Drops any reference that doesn't resolve to a
 * declared DataObject (precise validation lives in the parser; this is defensive).
 */
export function dataAssociations(ast: ProcessAST): DataAssociation[] {
  const known = new Set(ast.dataObjects.map((d) => d.id));
  const out: DataAssociation[] = [];
  for (const el of ast.elements) {
    if (!el.ioSpec) continue;
    for (const obj of el.ioSpec.inputs) {
      if (known.has(obj)) out.push({ activityId: el.id, direction: 'input', dataObject: obj });
    }
    for (const obj of el.ioSpec.outputs) {
      if (known.has(obj)) out.push({ activityId: el.id, direction: 'output', dataObject: obj });
    }
  }
  return out;
}
