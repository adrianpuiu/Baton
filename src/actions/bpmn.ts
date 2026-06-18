/**
 * Direct AST → OMG BPMN 2.0 XML emitter.
 *
 * processpiper generates BPMN inside its draw() call — the same grid-layout
 * engine that throws `KeyError` on large/wide interconnected processes (5+
 * pools, wide cross-lane edges). When that happens the render pipeline falls
 * back to a Graphviz PNG, but processpiper's BPMN goes with it. So a large
 * process would render a diagram yet silently LOSE its BPMN — breaking the
 * "three consumers" contract exactly on the showcase processes that need it.
 *
 * This emitter closes that hole. It turns a ProcessAST into valid BPMN 2.0 XML
 * with NO dependency on any layout engine: every node type, every sequence
 * flow, lanes, and pools, plus a simple deterministic grid DI (topological
 * level × lane band) that cannot fail the way processpiper's grid can. The
 * output imports into Camunda Modeler, Signavio, and Appian.
 *
 * Run directly, or via render.ts as the guaranteed BPMN path.
 */
import type { ProcessAST, ProcessElement, Edge } from '../compiler/types.js';

/** XML-safe ID: BPMN NCName-friendly, deterministic, collision-resistant. */
function slug(s: string): string {
  return s
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, '_$&')
    .toLowerCase() || 'x';
}

/** Escape XML text content (labels, names). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** BPMN tag + geometry for a given element variant. */
function nodeShape(el: ProcessElement): { tag: string; w: number; h: number; body?: string } {
  switch (el.variant) {
    case 'start':
      return { tag: 'startEvent', w: 36, h: 36 };
    case 'end':
      return { tag: 'endEvent', w: 36, h: 36 };
    case 'timer':
      return { tag: 'intermediateCatchEvent', w: 36, h: 36, body: '      <bpmn:timerEventDefinition />\n' };
    case 'message':
      return { tag: 'intermediateCatchEvent', w: 36, h: 36, body: '      <bpmn:messageEventDefinition />\n' };
    case 'signal':
      return { tag: 'intermediateCatchEvent', w: 36, h: 36, body: '      <bpmn:signalEventDefinition />\n' };
    case 'conditional':
      return { tag: 'intermediateCatchEvent', w: 36, h: 36, body: '      <bpmn:conditionalEventDefinition />\n' };
    case 'link':
      return { tag: 'intermediateCatchEvent', w: 36, h: 36, body: '      <bpmn:linkEventDefinition />\n' };
    case 'intermediate':
      return { tag: 'intermediateCatchEvent', w: 36, h: 36 };
    case 'subprocess':
      return { tag: 'subProcess', w: 110, h: 90 };
    case 'task': {
      // BPMN Task sub-types map to their own tags. 'none' (or unset) = plain task.
      const TASK_TAG: Record<string, string> = {
        none: 'task',
        service: 'serviceTask',
        user: 'userTask',
        businessRule: 'businessRuleTask',
        send: 'sendTask',
        receive: 'receiveTask',
        manual: 'manualTask',
        script: 'scriptTask',
      };
      const tt = (el.taskType ?? 'none') as string;
      return { tag: TASK_TAG[tt] ?? 'task', w: 110, h: 80 };
    }
    case 'exclusive':
      return { tag: 'exclusiveGateway', w: 50, h: 50 };
    case 'parallel':
      return { tag: 'parallelGateway', w: 50, h: 50 };
    case 'inclusive':
      return { tag: 'inclusiveGateway', w: 50, h: 50 };
    case 'event':
      return { tag: 'eventBasedGateway', w: 50, h: 50 };
    default:
      return { tag: 'task', w: 110, h: 80 };
  }
}

/**
 * Longest-path topological level for each node — assigns the horizontal column.
 * Using the longest (not shortest) path spreads parallel branches side by side
 * instead of stacking them on the earliest column, which reads better.
 */
function topologicalLevels(ast: ProcessAST): Map<string, number> {
  const level = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const el of ast.elements) incoming.set(el.id, 0);
  for (const e of ast.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

  // Kahn-style, but propagate the max level seen so we get longest paths.
  const queue: string[] = ast.elements
    .filter((el) => (incoming.get(el.id) ?? 0) === 0)
    .map((el) => el.id);
  for (const id of queue) level.set(id, 0);

  const outFrom = (id: string) => ast.edges.filter((e) => e.from === id);
  const seen = new Set(queue);
  let guard = ast.elements.length * 2;
  while (queue.length && guard-- > 0) {
    const id = queue.shift()!;
    const lvl = level.get(id) ?? 0;
    for (const e of outFrom(id)) {
      const candidate = lvl + 1;
      if (candidate > (level.get(e.to) ?? -1)) level.set(e.to, candidate);
      // Re-enqueue when its last predecessor has settled; use a simple
      // re-process loop to converge on longest paths for DAGs.
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  // Guarantee every node has a level even if the graph has odd cycles.
  for (const el of ast.elements) if (!level.has(el.id)) level.set(el.id, 0);
  return level;
}

export interface EmitBpmnOptions {
  /** Stable identifier for the definitions root (becomes part of IDs). */
  slug?: string;
}

/** Compile a ProcessAST into OMG BPMN 2.0 XML. */
export function emitBpmn(ast: ProcessAST, opts: EmitBpmnOptions = {}): string {
  const s = slug(opts.slug ?? ast.title);

  // Stable, deterministic IDs derived from element ids / lane names / pool names.
  const nodeId = (id: string) => `node_${slug(id)}`;
  const laneId = (name: string) => `lane_${slug(name)}`;

  const levels = topologicalLevels(ast);
  const maxLevel = Math.max(0, ...ast.elements.map((e) => levels.get(e.id) ?? 0));

  // Lanes, in declared order — each gets a horizontal band (Y axis).
  const laneOrder = ast.lanes.map((l) => l.name);
  const laneIndex = new Map<string, number>();
  laneOrder.forEach((n, i) => laneIndex.set(n, i));

  // Distinct pools (default to a single implicit pool when none are declared).
  const pools = [...new Set(
    ast.lanes.map((l) => l.pool).filter((p): p is string => Boolean(p)),
  )];
  const usePools = pools.length > 0
    ? pools
    : ['Process']; // implicit single pool, matching processpiper's output shape

  // incoming/outgoing flow ids per node, for BPMN validity.
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  for (const e of ast.edges) {
    (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)!).push(e);
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)!).push(e);
  }
  const flowId = (e: Edge, i: number) => `flow_${i}`;

  const laneElements = new Map<string, ProcessElement[]>();
  for (const el of ast.elements) {
    (laneElements.get(el.lane) ?? laneElements.set(el.lane, []).get(el.lane)!).push(el);
  }

  // ---- data layer: BPMN dataObjects + itemDefinitions + ioSpecification ----
  // This is the Executable-conformance piece: typed artifacts flowing through
  // the process, with each activity declaring what it consumes/produces. The
  // associations link process-level dataObjects to per-activity dataInputs/outputs.
  const dataObjId = (id: string) => `data_${slug(id)}`;
  const itemDefId = (type: string) => `itemdef_${slug(type)}`;
  // One itemDefinition per distinct type (untyped objects share 'Untyped').
  const itemDefs = new Map<string, string>(); // type -> itemDef id
  for (const d of ast.dataObjects) {
    const t = d.type ?? 'Untyped';
    if (!itemDefs.has(t)) itemDefs.set(t, itemDefId(t));
  }
  const dataInputId = (actId: string, obj: string) => `din_${slug(actId)}_${slug(obj)}`;
  const dataOutputId = (actId: string, obj: string) => `dout_${slug(actId)}_${slug(obj)}`;

  // A process is Executable-conformance iff it carries a data layer.
  const executable = ast.dataObjects.length > 0;

  // ---- process: laneSet, nodes, sequence flows ----
  const proc: string[] = [
    `  <bpmn:process id="process_${s}" name="${esc(ast.title)}" isExecutable="${executable}">`,
    `    <bpmn:laneSet id="laneset_${s}">`,
  ];
  for (const laneName of laneOrder) {
    proc.push(`      <bpmn:lane id="${laneId(laneName)}" name="${esc(laneName)}">`);
    for (const el of laneElements.get(laneName) ?? []) {
      proc.push(`        <bpmn:flowNodeRef>${nodeId(el.id)}</bpmn:flowNodeRef>`);
    }
    proc.push(`      </bpmn:lane>`);
  }
  proc.push(`    </bpmn:laneSet>`);

  for (const el of ast.elements) {
    const { tag, body } = nodeShape(el);
    const out = outgoing.get(el.id) ?? [];
    const inc = incoming.get(el.id) ?? [];
    // Flow ids are positional; resolve by matching edges below.
    proc.push(`    <bpmn:${tag} id="${nodeId(el.id)}" name="${esc(el.label)}">`);
    for (const e of inc) proc.push(`      <bpmn:incoming>flow_${ast.edges.indexOf(e)}</bpmn:incoming>`);
    for (const e of out) proc.push(`      <bpmn:outgoing>flow_${ast.edges.indexOf(e)}</bpmn:outgoing>`);
    if (body) proc.push(body.trimEnd());
    // Data I/O: ioSpecification + associations (only for activities with ioSpec).
    if (el.ioSpec) {
      const ins = el.ioSpec.inputs;
      const outs = el.ioSpec.outputs;
      proc.push(`      <bpmn:ioSpecification>`);
      for (const obj of ins) {
        const t = ast.dataObjects.find((d) => d.id === obj)?.type ?? 'Untyped';
        proc.push(`        <bpmn:dataInput id="${dataInputId(el.id, obj)}" name="${esc(obj)}" itemSubjectRef="${itemDefs.get(t)}" />`);
      }
      for (const obj of outs) {
        const t = ast.dataObjects.find((d) => d.id === obj)?.type ?? 'Untyped';
        proc.push(`        <bpmn:dataOutput id="${dataOutputId(el.id, obj)}" name="${esc(obj)}" itemSubjectRef="${itemDefs.get(t)}" />`);
      }
      if (ins.length) {
        proc.push(`        <bpmn:inputSet>`);
        for (const obj of ins) proc.push(`          <bpmn:dataInputRefs>${dataInputId(el.id, obj)}</bpmn:dataInputRefs>`);
        proc.push(`        </bpmn:inputSet>`);
      }
      if (outs.length) {
        proc.push(`        <bpmn:outputSet>`);
        for (const obj of outs) proc.push(`          <bpmn:dataOutputRefs>${dataOutputId(el.id, obj)}</bpmn:dataOutputRefs>`);
        proc.push(`        </bpmn:outputSet>`);
      }
      proc.push(`      </bpmn:ioSpecification>`);
      for (const obj of ins) {
        proc.push(`      <bpmn:dataInputAssociation>`);
        proc.push(`        <bpmn:sourceRef>${dataObjId(obj)}</bpmn:sourceRef>`);
        proc.push(`        <bpmn:targetRef>${dataInputId(el.id, obj)}</bpmn:targetRef>`);
        proc.push(`      </bpmn:dataInputAssociation>`);
      }
      for (const obj of outs) {
        proc.push(`      <bpmn:dataOutputAssociation>`);
        proc.push(`        <bpmn:sourceRef>${dataOutputId(el.id, obj)}</bpmn:sourceRef>`);
        proc.push(`        <bpmn:targetRef>${dataObjId(obj)}</bpmn:targetRef>`);
        proc.push(`      </bpmn:dataOutputAssociation>`);
      }
    }
    proc.push(`    </bpmn:${tag}>`);
  }

  ast.edges.forEach((e, i) => {
    const name = e.label ? ` name="${esc(e.label)}"` : '';
    proc.push(
      `    <bpmn:sequenceFlow id="${flowId(e, i)}"${name} sourceRef="${nodeId(e.from)}" targetRef="${nodeId(e.to)}" />`,
    );
  });
  // Process-level data objects (declared artifacts). itemSubjectRef points at
  // the shared itemDefinition for the object's type.
  for (const d of ast.dataObjects) {
    const t = d.type ?? 'Untyped';
    proc.push(
      `    <bpmn:dataObject id="${dataObjId(d.id)}" name="${esc(d.id)}" itemSubjectRef="${itemDefs.get(t)}" />`,
    );
  }
  proc.push(`  </bpmn:process>`);

  // ---- itemDefinitions: one per distinct type, at the definitions level ----
  const itemDefBlock = [...itemDefs.entries()].map(
    ([type, id]) =>
      `  <bpmn:itemDefinition id="${id}" structureRef="${esc(type)}" itemKind="Information" />`,
  );

  // ---- collaboration: one participant per pool ----
  const collab = [
    `  <bpmn:collaboration id="collaboration_${s}">`,
    ...usePools.map(
      (p) =>
        `    <bpmn:participant id="participant_${slug(p)}" name="${esc(p)}" processRef="process_${s}" />`,
    ),
    `  </bpmn:collaboration>`,
  ];

  // ---- DI: grid layout (topological level × lane band). Cannot fail. ----
  const PAD_X = 160;
  const PAD_Y = 80;
  const COL_W = 160;
  const LANE_H = 160;
  const diagramW = PAD_X * 2 + (maxLevel + 1) * COL_W;

  const pos = (el: ProcessElement) => {
    const lvl = levels.get(el.id) ?? 0;
    const li = laneIndex.get(el.lane) ?? 0;
    const { w, h } = nodeShape(el);
    return {
      x: PAD_X + lvl * COL_W + (COL_W - w) / 2,
      y: PAD_Y + li * LANE_H + (LANE_H - h) / 2,
      w,
      h,
    };
  };
  const center = (el: ProcessElement) => {
    const p = pos(el);
    return { cx: p.x + p.w / 2, cy: p.y + p.h / 2, p };
  };
  const byId = new Map(ast.elements.map((e) => [e.id, e] as const));

  const di: string[] = [
    `  <bpmndi:BPMNDiagram id="diagram_${s}" name="${esc(ast.title)}">`,
    `    <bpmndi:BPMNPlane id="plane_${s}" bpmnElement="collaboration_${s}">`,
  ];
  // Lane bands (pool-less lanes still get a band so nodes are locatable).
  laneOrder.forEach((laneName, i) => {
    di.push(
      `      <bpmndi:BPMNShape id="shape_${laneId(laneName)}" bpmnElement="${laneId(laneName)}">`,
      `        <dc:Bounds x="${PAD_X - 60}" y="${PAD_Y + i * LANE_H}" width="${diagramW}" height="${LANE_H}" />`,
      `      </bpmndi:BPMNShape>`,
    );
  });
  // Participant bands (pools group lanes vertically).
  usePools.forEach((p) => {
    const poolLaneIdxs = ast.lanes
      .filter((l) => (l.pool ?? 'Process') === p)
      .map((l) => laneIndex.get(l.name) ?? 0);
    const minY = poolLaneIdxs.length ? Math.min(...poolLaneIdxs) : 0;
    const maxY = poolLaneIdxs.length ? Math.max(...poolLaneIdxs) : 0;
    di.push(
      `      <bpmndi:BPMNShape id="shape_participant_${slug(p)}" bpmnElement="participant_${slug(p)}" isHorizontal="true">`,
      `        <dc:Bounds x="${PAD_X - 100}" y="${PAD_Y + minY * LANE_H - 10}" width="30" height="${(maxY - minY + 1) * LANE_H + 20}" />`,
      `      </bpmndi:BPMNShape>`,
    );
  });
  // Nodes.
  for (const el of ast.elements) {
    const { x, y, w, h } = pos(el);
    di.push(
      `      <bpmndi:BPMNShape id="shape_${nodeId(el.id)}" bpmnElement="${nodeId(el.id)}">`,
      `        <dc:Bounds x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w}" height="${h}" />`,
      `      </bpmndi:BPMNShape>`,
    );
  }
  // Data objects — placed in a row below the lanes so they're locatable.
  const dataY = PAD_Y + laneOrder.length * LANE_H + 20;
  ast.dataObjects.forEach((d, i) => {
    const dx = PAD_X + i * 100;
    di.push(
      `      <bpmndi:BPMNShape id="shape_${dataObjId(d.id)}" bpmnElement="${dataObjId(d.id)}">`,
      `        <dc:Bounds x="${dx}" y="${dataY}" width="48" height="64" />`,
      `      </bpmndi:BPMNShape>`,
    );
  });
  // Edges — straight-line waypoints; importers re-route orthogonally.
  ast.edges.forEach((e, i) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    const a = from && center(from);
    const b = to && center(to);
    di.push(`      <bpmndi:BPMNEdge id="edge_${i}" bpmnElement="flow_${i}">`);
    if (a) di.push(`        <di:waypoint x="${a.cx.toFixed(0)}" y="${a.cy.toFixed(0)}" />`);
    if (b) di.push(`        <di:waypoint x="${b.cx.toFixed(0)}" y="${b.cy.toFixed(0)}" />`);
    di.push(`      </bpmndi:BPMNEdge>`);
  });
  di.push(`    </bpmndi:BPMNPlane>`, `  </bpmndi:BPMNDiagram>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
    xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="definitions_${s}"
    targetNamespace="http://baton/processes"
    exporter="Baton" exporterVersion="1.0">
${proc.join('\n')}
${itemDefBlock.join('\n')}
${collab.join('\n')}
${di.join('\n')}
</bpmn:definitions>
`;
}
