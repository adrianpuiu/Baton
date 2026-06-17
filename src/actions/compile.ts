import { parsePiperFlow } from '../compiler/parse.js';
import { emitFlueWorkflow, type EmitOptions } from '../compiler/emit.js';

/** Parse + compile in one shot. Pure function, no I/O. */
export function compileToFlue(dsl: string, opts: EmitOptions) {
  const ast = parsePiperFlow(dsl);
  const code = emitFlueWorkflow(ast, opts);
  return { ast, code };
}
