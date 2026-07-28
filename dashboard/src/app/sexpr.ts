export type SExpressionTokenKind =
  | 'comment'
  | 'keyword'
  | 'literal'
  | 'number'
  | 'operator'
  | 'paren'
  | 'string'
  | 'symbol'
  | 'whitespace'

export interface PrettySExpressionToken {
  kind: SExpressionTokenKind
  text: string
}

export interface PrettySExpression {
  text: string
  tokens: PrettySExpressionToken[]
  valid: boolean
}

interface AtomNode {
  type: 'atom'
  kind: Exclude<SExpressionTokenKind, 'operator' | 'paren' | 'whitespace'>
  value: string
}

interface ListNode {
  type: 'list'
  children: SExpressionNode[]
}

type SExpressionNode = AtomNode | ListNode

interface LexToken {
  kind: 'atom' | 'close' | 'comment' | 'open' | 'string'
  value: string
}

const INLINE_LIST_WIDTH = 88

function lex(source: string): LexToken[] {
  const tokens: LexToken[] = []
  let cursor = 0

  while (cursor < source.length) {
    const character = source[cursor]
    if (/\s/u.test(character)) {
      cursor += 1
      continue
    }
    if (character === '(') {
      tokens.push({ kind: 'open', value: character })
      cursor += 1
      continue
    }
    if (character === ')') {
      tokens.push({ kind: 'close', value: character })
      cursor += 1
      continue
    }
    if (character === ';') {
      const start = cursor
      while (cursor < source.length && source[cursor] !== '\n') cursor += 1
      tokens.push({ kind: 'comment', value: source.slice(start, cursor) })
      continue
    }
    if (character === '"') {
      const start = cursor
      cursor += 1
      let escaped = false
      while (cursor < source.length) {
        const current = source[cursor]
        cursor += 1
        if (escaped) {
          escaped = false
        } else if (current === '\\') {
          escaped = true
        } else if (current === '"') {
          break
        }
      }
      tokens.push({ kind: 'string', value: source.slice(start, cursor) })
      continue
    }

    const start = cursor
    while (
      cursor < source.length
      && !/\s/u.test(source[cursor])
      && source[cursor] !== '('
      && source[cursor] !== ')'
    ) {
      cursor += 1
    }
    tokens.push({ kind: 'atom', value: source.slice(start, cursor) })
  }

  return tokens
}

function atomKind(value: string): AtomNode['kind'] {
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) return 'number'
  if (/^(?:#t|#f|true|false|nil|null)$/iu.test(value)) return 'literal'
  if (value.startsWith(':')) return 'keyword'
  return 'symbol'
}

function parse(tokens: LexToken[]): { nodes: SExpressionNode[], valid: boolean } {
  const root: ListNode = { type: 'list', children: [] }
  const stack: ListNode[] = [root]
  let valid = true

  for (const token of tokens) {
    const parent = stack[stack.length - 1]
    if (token.kind === 'open') {
      const list: ListNode = { type: 'list', children: [] }
      parent.children.push(list)
      stack.push(list)
    } else if (token.kind === 'close') {
      if (stack.length === 1) valid = false
      else stack.pop()
    } else {
      parent.children.push({
        type: 'atom',
        kind: token.kind === 'string'
          ? 'string'
          : token.kind === 'comment'
            ? 'comment'
            : atomKind(token.value),
        value: token.value,
      })
    }
  }

  if (stack.length !== 1) valid = false
  return { nodes: root.children, valid }
}

function flatLength(node: SExpressionNode, limit = INLINE_LIST_WIDTH): number {
  if (node.type === 'atom') return node.value.length
  let length = 2
  for (const child of node.children) {
    if (length > 2) length += 1
    length += flatLength(child, limit)
    if (length > limit) return length
  }
  return length
}

function push(
  output: PrettySExpressionToken[],
  text: string,
  kind: SExpressionTokenKind = 'whitespace',
) {
  if (!text) return
  const previous = output[output.length - 1]
  if (previous?.kind === kind && kind === 'whitespace') previous.text += text
  else output.push({ kind, text })
}

function renderAtom(
  node: AtomNode,
  output: PrettySExpressionToken[],
  operator: boolean,
) {
  push(output, node.value, operator && node.kind === 'symbol' ? 'operator' : node.kind)
}

function renderInline(node: SExpressionNode, output: PrettySExpressionToken[]) {
  if (node.type === 'atom') {
    renderAtom(node, output, false)
    return
  }
  push(output, '(', 'paren')
  node.children.forEach((child, index) => {
    if (index > 0) push(output, ' ')
    if (child.type === 'atom') renderAtom(child, output, index === 0)
    else renderInline(child, output)
  })
  push(output, ')', 'paren')
}

function renderNode(
  node: SExpressionNode,
  depth: number,
  output: PrettySExpressionToken[],
) {
  if (node.type === 'atom') {
    renderAtom(node, output, false)
    return
  }

  const hasNestedList = node.children.some(child => child.type === 'list')
  if (
    !hasNestedList
    && flatLength(node) <= INLINE_LIST_WIDTH
    && !node.children.some(child => child.type === 'atom' && child.kind === 'comment')
  ) {
    renderInline(node, output)
    return
  }

  push(output, '(', 'paren')
  node.children.forEach((child, index) => {
    if (index === 0 && child.type === 'atom') {
      renderAtom(child, output, true)
      return
    }

    if (child.type === 'list' || child.kind === 'comment') {
      push(output, `\n${'  '.repeat(depth + 1)}`)
      renderNode(child, depth + 1, output)
      return
    }

    push(output, ' ')
    renderAtom(child, output, false)
  })
  // Lisp convention keeps closing parens with the last child. This keeps
  // deeply nested Context Encodings compact without losing their hierarchy.
  push(output, ')', 'paren')
}

/**
 * Formats Morphz's semantic S-expression for human inspection only.
 *
 * The returned text is never fed back into Context Encoding, so this reader
 * cannot accidentally change the model-visible prompt or its prefix cache.
 */
export function prettyPrintSExpression(source: string): PrettySExpression {
  const normalized = source.trim()
  if (!normalized) return { text: '', tokens: [], valid: true }

  const parsed = parse(lex(normalized))
  if (!parsed.valid) {
    return {
      text: normalized,
      tokens: [{ kind: 'symbol', text: normalized }],
      valid: false,
    }
  }

  const output: PrettySExpressionToken[] = []
  parsed.nodes.forEach((node, index) => {
    if (index > 0) push(output, '\n')
    renderNode(node, 0, output)
  })
  return {
    text: output.map(token => token.text).join(''),
    tokens: output,
    valid: true,
  }
}
