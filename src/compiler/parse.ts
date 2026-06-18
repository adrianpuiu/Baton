import type { ProcessAST, ProcessElement } from './types.js';

export class ParseError extends Error {}

/** Parse an activity I/O block body like 'in: order; out: validated_order'. */
function parseIoBlock(body: string): { inputs: string[]; outputs: string[] } {
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const part of body.split(/[;,\n]/)) {
    const m = part.match(/^\s*(in|out)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const refs = m[2].split(/\s+/).filter(Boolean);
    if (m[1].toLowerCase() === 'in') inputs.push(...refs);
    else outputs.push(...refs);
  }
  return { inputs, outputs };
}

const RE = {
  title: /^title:\s*(.+?)\s*$/i,
  width: /^width:\s*(\d+)\s*$/i,
  theme: /^(?:colourtheme|colortheme):\s*(.+?)\s*$/i,
  footer: /^footer:\s*(.+?)\s*$/i,
  pool: /^\s*pool:\s*(.+?)\s*$/i,
  lane: /^\s*lane:\s*(.+?)\s*$/i,
  // Data object: 'data: <name>' or 'data: <name> : <type>'. Type optional.
  data: /^\s*data:\s*([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*))?\s*$/i,
  // Element shapes. group1 = optional @type marker, group2 = label, group3 = id,
  // group4 = optional '{ in: ...; out: ... }' I/O block (activities only).
  // Markers only ever start with '@' (e.g. @timer, @subprocess, @parallel,
  // @business-rule) — a bare word like 'Place' in [Place Order] is part of the
  // label, not a marker. Markers may contain hyphens (task sub-type names).
  event: /^\s*\(\s*(@[\w-]+|start|end)?\s*(.*?)\)\s+as\s+([A-Za-z_]\w*)\s*$/,
  activity: /^\s*\[\s*(@[\w-]+)?\s*(.*?)\]\s+as\s+([A-Za-z_]\w*)\s*(?:\{(.*?)\})?\s*$/,
  gateway: /^\s*<\s*(@[\w-]+)?\s*(.*?)>\s+as\s+([A-Za-z_]\w*)\s*$/,
  // Connection line: one or more ids joined by ->, optionally with per-hop
  // side specs `-(bottom, top)` and a trailing `: label`.
  edge: /^([A-Za-z_]\w*(?:\s*(?:-\s*\([^)]*\)\s*)?->\s*[A-Za-z_]\w*)+)\s*(?::\s*(.*?))?\s*$/,
};

const EVENT_VARIANTS: Record<string, ProcessElement['variant']> = {
  start: 'start', end: 'end',
  '@timer': 'timer', '@intermediate': 'intermediate', '@message': 'message',
  '@signal': 'signal', '@conditional': 'conditional', '@link': 'link',
  // An empty/paren-only event with no @marker is treated as a plain intermediate.
  '': 'intermediate',
};
const ACTIVITY_VARIANTS: Record<string, ProcessElement['variant']> = {
  '': 'task', '@subprocess': 'subprocess',
};
/**
 * BPMN Task sub-type markers → TaskType. All map to variant 'task' (the OMG
 * model: Task has these implementations as sub-types); the variant stays 'task'
 * and the specific kind rides on ProcessElement.taskType. '@subprocess' is a
 * separate axis (Activity type, not Task sub-type) so it lives in ACTIVITY_VARIANTS.
 */
const TASK_TYPE_MARKERS: Record<string, import('./types.js').TaskType> = {
  '@service': 'service',
  '@user': 'user',
  '@business-rule': 'businessRule',
  '@rule': 'businessRule',
  '@send': 'send',
  '@receive': 'receive',
  '@manual': 'manual',
  '@script': 'script',
};;
const GATEWAY_VARIANTS: Record<string, ProcessElement['variant']> = {
  '': 'exclusive', '@parallel': 'parallel', '@inclusive': 'inclusive', '@event': 'event',
};

/** Strip per-hop connection-side specs `-(bottom, top)` — visual only. */
const stripSides = (token: string): string => token.replace(/\s*-\s*\([^)]*\)\s*(?=->)/g, '');

/**
 * Parse PiperFlow text into a validated ProcessAST.
 * Throws ParseError on malformed input or dangling edge references.
 */
export function parsePiperFlow(dsl: string): ProcessAST {
  const lines = dsl.replace(/\r\n/g, '\n').split('\n');
  const ast: ProcessAST = { title: 'Untitled Process', lanes: [], elements: [], edges: [], dataObjects: [] };

  let currentPool: string | undefined;
  let currentLane: string | undefined;

  const declareLane = (name: string) => {
    if (!ast.lanes.some((l) => l.name === name && l.pool === currentPool)) {
      ast.lanes.push({ name, pool: currentPool });
    }
    currentLane = name;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;

    let m: RegExpMatchArray | null;
    if ((m = line.match(RE.title))) { ast.title = m[1]; continue; }
    if ((m = line.match(RE.width))) {
      // Clamp: the regex accepts arbitrarily long digit strings, but Number()
      // loses precision above 2^53-1. Cap at MAX_SAFE_INTEGER so the AST stays
      // faithful instead of silently rounding a huge render-width hint.
      const w = Number(m[1]);
      ast.width = w > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : w;
      continue;
    }
    if ((m = line.match(RE.theme))) { ast.theme = m[1]; continue; }
    if ((m = line.match(RE.footer))) { ast.footer = m[1]; continue; }
    if ((m = line.match(RE.pool))) { currentPool = m[1]; currentLane = undefined; continue; }
    if ((m = line.match(RE.lane))) { declareLane(m[1]); continue; }
    if ((m = line.match(RE.data))) {
      // Data object: 'data: <name>' or 'data: <name> : <type>'. Type optional.
      const name = m[1];
      if (!ast.dataObjects.some((d) => d.id === name)) {
        ast.dataObjects.push({ id: name, ...(m[2] ? { type: m[2] } : {}) });
      }
      continue;
    }

    let shape: 'event' | 'activity' | 'gateway' | null = null;
    let marker = '';
    let label = '';
    let id = '';
    if ((m = line.match(RE.event))) { shape = 'event'; }
    else if ((m = line.match(RE.activity))) { shape = 'activity'; }
    else if ((m = line.match(RE.gateway))) { shape = 'gateway'; }

    if (shape && m) {
      marker = m[1];
      label = m[2];
      id = m[3];
      const variantMap = shape === 'event' ? EVENT_VARIANTS : shape === 'activity' ? ACTIVITY_VARIANTS : GATEWAY_VARIANTS;
      // Activities: a task sub-type marker (@service, @user, ...) sets
      // variant='task' + taskType rather than going through ACTIVITY_VARIANTS.
      let variant: ProcessElement['variant'] | undefined;
      let taskType: import('./types.js').TaskType | undefined;
      if (shape === 'activity' && marker && marker in TASK_TYPE_MARKERS) {
        variant = 'task';
        taskType = TASK_TYPE_MARKERS[marker];
      } else {
        variant = variantMap[marker ?? ''];
      }
      if (!variant) throw new ParseError(`Unknown ${shape} marker '${marker || '(none)'}' for element '${id}'. Expected one of: ${[...Object.keys(variantMap), ...(shape === 'activity' ? Object.keys(TASK_TYPE_MARKERS) : [])].map((k) => k || 'default').join(', ')}`);
      if (!currentLane) throw new ParseError(`Element '${id}' declared before any lane.`);

      // Events have no free label for start/end; synthesise a display label.
      const displayLabel =
        shape === 'event' && (variant === 'start' || variant === 'end')
          ? variant.charAt(0).toUpperCase() + variant.slice(1)
          : label.trim();

      const el: ProcessElement = {
        id,
        label: displayLabel,
        lane: currentLane,
        category: shape === 'event' ? 'event' : shape === 'activity' ? 'activity' : 'gateway',
        variant,
        ...(currentPool ? { pool: currentPool } : {}),
        // Activity I/O block '{ in: ...; out: ... }' → ioSpec (BPMN ioSpecification).
        ...(shape === 'activity' && m[4]?.trim() ? { ioSpec: parseIoBlock(m[4]) } : {}),
        // Task sub-type (@service, @user, ...) → BPMN task implementation tag.
        ...(taskType ? { taskType } : {}),
      };
      ast.elements.push(el);
      continue;
    }

    if ((m = line.match(RE.edge))) {
      const label = m[2]?.trim();
      const ids = stripSides(m[1]).split('->').map((s) => s.trim());
      for (let i = 0; i < ids.length - 1; i++) {
        const isLast = i === ids.length - 2;
        ast.edges.push({ from: ids[i], to: ids[i + 1], ...(isLast && label ? { label } : {}) });
      }
      continue;
    }

    if (line.trim()) console.warn(`[parse] skipping unrecognised line: ${line}`);
  }

  validate(ast);
  return ast;
}

function validate(ast: ProcessAST): void {
  const ids = new Set(ast.elements.map((e) => e.id));
  for (const e of ast.edges) {
    if (!ids.has(e.from)) throw new ParseError(`Edge references unknown element: '${e.from}'`);
    if (!ids.has(e.to)) throw new ParseError(`Edge references unknown element: '${e.to}'`);
  }
  const starts = ast.elements.filter((e) => e.category === 'event' && e.variant === 'start');
  if (starts.length === 0) throw new ParseError('Process has no (start) element.');
  if (starts.length > 1) throw new ParseError('Process has more than one (start) element.');

  // Data I/O integrity: every activity in/out reference must resolve to a
  // declared data object. Precise + actionable so the self-healing loop can
  // feed the exact defect back to the model — same philosophy as orphan/edge
  // checks above. This is what makes the emitted BPMN Executable-conformance.
  const knownData = new Set(ast.dataObjects.map((d) => d.id));
  for (const el of ast.elements) {
    if (!el.ioSpec) continue;
    for (const ref of [...el.ioSpec.inputs, ...el.ioSpec.outputs]) {
      if (!knownData.has(ref)) {
        throw new ParseError(
          `Activity '${el.id}' references unknown data object '${ref}' in its { in/out } spec. Declare it first with: data: ${ref} : <Type>`,
        );
      }
    }
  }

  // Orphan detection: every element must participate in at least one connection.
  // Matches processpiper's own contract — catching it here gives a precise, actionable
  // message instead of a cryptic Python traceback, and lets the self-healing loop
  // feed the exact defect back to the model.
  const connected = new Set<string>();
  for (const e of ast.edges) { connected.add(e.from); connected.add(e.to); }
  const orphans = ast.elements.filter((e) => !connected.has(e.id));
  if (orphans.length) {
    throw new ParseError(
      `These elements are declared but never connected — every element must participate in at least one connection: ${orphans.map((o) => `'${o.id}'`).join(', ')}. Either wire them into the flow or remove them.`,
    );
  }
}
