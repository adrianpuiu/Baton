"""Render PiperFlow DSL (read from stdin) via processpiper.

Usage: render.py <output.png|svg> [--bpmn]

processpiper's render() may return None (legacy) or (gen_code, img) (current).
We handle both, and ensure the file is written. With --bpmn, also emit a
sibling .bpmn (XML) file that imports into Camunda, Signavio, Appian, etc.
"""
import json
import os
import sys

from processpiper.text2diagram import render

if len(sys.argv) < 2:
    print("usage: render.py <output.png|svg> [--bpmn]", file=sys.stderr)
    sys.exit(2)

out_path = sys.argv[1]
want_bpmn = "--bpmn" in sys.argv[2:]
dsl = sys.stdin.read()

# Try the modern signature (with export_to_bpmn), fall back to the plain call.
try:
    result = (
        render(dsl, out_path, export_to_bpmn=want_bpmn)
        if want_bpmn
        else render(dsl, out_path)
    )
except TypeError:
    result = render(dsl, out_path)

img = None
if isinstance(result, tuple) and len(result) == 2:
    _, img = result

# Ensure the raster/vector file exists regardless of which API shape we got.
if img is not None and not os.path.exists(out_path):
    img.save(out_path)

artifacts = [out_path]
if want_bpmn:
    bpmn_path = os.path.splitext(out_path)[0] + ".bpmn"
    if os.path.exists(bpmn_path):
        artifacts.append(bpmn_path)

print(json.dumps({"ok": True, "artifacts": artifacts}))
