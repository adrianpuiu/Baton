/**
 * The PiperFlow AST.
 *
 * The DSL is the single source of truth. Consumers of this AST:
 *   - render  → PNG / SVG / BPMN-XML (via processpiper)
 *   - compile → a runnable Flue workflow (lanes→agents, tasks→calls,
 *               gateways→ conditional / parallel branches)
 *
 * Element taxonomy follows the official ProcessPiper grammar:
 *   events    : start, end, timer, intermediate, message, signal, conditional, link
 *   activities: task (default), subprocess
 *   gateways  : exclusive (default), parallel, inclusive, event
 */

export type ElementCategory = 'event' | 'activity' | 'gateway';
export type EventVariant =
  | 'start' | 'end' | 'timer' | 'intermediate'
  | 'message' | 'signal' | 'conditional' | 'link';
export type ActivityVariant = 'task' | 'subprocess';
export type GatewayVariant = 'exclusive' | 'parallel' | 'inclusive' | 'event';

export interface ProcessElement {
  id: string;
  label: string;
  lane: string;
  pool?: string;
  category: ElementCategory;
  variant: EventVariant | ActivityVariant | GatewayVariant;
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
}

/** Convenience guards used by the compiler and executor. */
export const isStart = (e: ProcessElement): boolean => e.category === 'event' && e.variant === 'start';
export const isEnd = (e: ProcessElement): boolean => e.category === 'event' && e.variant === 'end';
export const isGateway = (e: ProcessElement): boolean => e.category === 'gateway';
export const isTask = (e: ProcessElement): boolean => e.category === 'activity' && e.variant === 'task';
export const isParallel = (e: ProcessElement): boolean => e.category === 'gateway' && e.variant === 'parallel';
