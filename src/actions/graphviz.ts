import type { ProcessAST } from '../compiler/types.js';

const SHAPE: Record<string, string> = {
  start: 'circle', end: 'circle', timer: 'ellipse', intermediate: 'ellipse',
  message: 'ellipse', signal: 'ellipse', conditional: 'ellipse', link: 'ellipse',
  task: 'box', subprocess: 'box',
  exclusive: 'diamond', parallel: 'diamond', inclusive: 'diamond', event: 'diamond',
};
const STYLE: Record<string, string> = {
  start: 'filled', end: 'filled', timer: 'filled', intermediate: 'dashed',
  message: 'filled', task: 'filled', subprocess: 'filled,bold',
  exclusive: 'filled', parallel: 'filled', inclusive: 'filled',
};

/**
 * Fallback structural renderer: turn a ProcessAST into a Graphviz DOT graph.
 *
 * Used when processpiper's grid-layout engine throws on a large/complex process
 * (it has known limits on wide interconnected graphs). This is a faithful
 * labelled digraph — same nodes, lanes as clusters, gateways as diamonds — so
 * the diagram is still useful; it just trades BPMN swimlane geometry for
 * guaranteed layout.
 */
export function toDot(ast: ProcessAST): string {
  const laneOf = new Map<string, string>();
  for (const el of ast.elements) laneOf.set(el.id, el.lane);

  const clusters = new Map<string, string[]>();
  for (const lane of ast.lanes) {
    const ids = ast.elements.filter((e) => e.lane === lane.name).map((e) => e.id);
    if (ids.length) clusters.set(lane.name, ids);
  }

  // Escape backslashes FIRST, then quotes: DOT treats `\` as an escape char
  // inside a quoted string, so a literal backslash (e.g. a Windows path in a
  // label) must be doubled before the surrounding quotes are handled.
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines: string[] = [
    'digraph process {',
    '  rankdir=LR;',
    '  graph [fontname="Helvetica", nodesep=0.4, ranksep=0.6, bgcolor="white"];',
    '  node [fontname="Helvetica", fontsize=10];',
    '  edge [fontname="Helvetica", fontsize=9, color="#555555"];',
  ];

  let ci = 0;
  for (const [lane, ids] of clusters) {
    lines.push(`  subgraph cluster_${ci++} {`);
    lines.push(`    label="${esc(lane)}"; style="rounded,dashed"; color="#9aa7b5"; fontcolor="#445566";`);
    for (const id of ids) {
      const el = ast.elements.find((e) => e.id === id)!;
      const shape = SHAPE[el.variant] ?? 'box';
      const style = STYLE[el.variant] ?? '';
      const fill = el.category === 'gateway' ? '#ffe08a' : el.category === 'event' ? '#bfe3b6' : '#dce8f5';
      const attrs = [`shape=${shape}`, `label="${esc(el.label)}"`, `style="${style}"`, `fillcolor="${fill}"`].filter((a) => !a.endsWith('=""'));
      lines.push(`    "${id}" [${attrs.join(', ')}];`);
    }
    lines.push('  }');
  }

  for (const e of ast.edges) {
    lines.push(e.label ? `  "${e.from}" -> "${e.to}" [label="${esc(e.label)}"];` : `  "${e.from}" -> "${e.to}";`);
  }
  lines.push('}');
  return lines.join('\n');
}
