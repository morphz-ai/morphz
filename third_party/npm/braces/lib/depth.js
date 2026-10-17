'use strict';

// A fixed security ceiling, not a caller-overridable expansion preference.
const MAX_DEPTH = 128;
const assertDepth = depth => {
  if (depth > MAX_DEPTH) throw new SyntaxError('Brace pattern exceeds maximum nesting depth (128)');
};

// Public compile/expand/stringify also accept caller-supplied ASTs. Check those
// iteratively before the recursive walkers, including cyclic/oversized input.
const assertAstDepth = ast => {
  const pending = [[ast, 0]];
  let nodes = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    assertDepth(depth);
    if (++nodes > 20000) throw new SyntaxError('Brace AST exceeds maximum node count (20000)');
    if (node && Array.isArray(node.nodes)) {
      for (const child of node.nodes) pending.push([child, depth + 1]);
    }
  }
};

module.exports = { assertDepth, assertAstDepth };
