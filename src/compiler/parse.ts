import type { ProcessAST, ProcessElement, Lane } from './types.js';

export class ParseError extends Error {}

const RE = {
  title: /^title:\s*(.+?)\s*$/i,
  width: /^width:\s*(\d+)\s*$/i,
  theme: /^(?:colourtheme|colortheme):\s*(.+?)\s*$/i,
  footer: /^footer:\s*(.+?)\s*$/i,
  pool: /^\s*pool:\s*(.+?)\s*$/i,
  lane: /^\s*lane:\s*(.+?)\s*$/i,
  // Element shapes. group1 = optional @type marker, group2 = label, group3 = id.
  // Markers only ever start with '@' (e.g. @timer, @subprocess, @parallel) —
  // a bare word like 'Place' in [Place Order] is part of the label, not a marker.
  event: /^\s*\(\s*(@\w+|start|end)?\s*(.*?)\)\s+as\s+([A-Za-z_]\w*)\s*$/,
  activity: /^\s*\[\s*(@\w+)?\s*(.*?)\]\s+as\s+([A-Za-z_]\w*)\s*$/,
  gateway: /^\s*<\s*(@\w+)?\s*(.*?)>\s+as\s+([A-Za-z_]\w*)\s*$/,
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
  const ast: ProcessAST = { title: 'Untitled Process', lanes: [], elements: [], edges: [] };

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
      const variant = variantMap[marker ?? ''];
      if (!variant) throw new ParseError(`Unknown ${shape} marker '${marker || '(none)'}' for element '${id}'. Expected one of: ${Object.keys(variantMap).map((k) => k || 'default').join(', ')}`);
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
