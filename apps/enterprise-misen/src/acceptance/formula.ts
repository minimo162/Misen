import { safeFormula } from '../capabilities/guards.js'

type Scalar = number | string | boolean
type Resolver = (coordinate: string) => Scalar
type Token = { kind: 'number' | 'string' | 'cell' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'colon' | 'eof'; value?: string }
type Node =
  | { kind: 'literal'; value: Scalar }
  | { kind: 'cell'; coordinate: string }
  | { kind: 'range'; start: string; end: string }
  | { kind: 'unary'; operator: '+' | '-'; value: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] }

function tokenize(formula: string): Token[] {
  const source = safeFormula(formula).slice(1)
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    if (/\s/u.test(source[index]!)) { index++; continue }
    const rest = source.slice(index)
    const cell = /^\$?[A-Za-z]{1,3}\$?\d+/u.exec(rest)
    if (cell) { tokens.push({ kind: 'cell', value: cell[0]!.replace(/\$/gu, '').toUpperCase() }); index += cell[0]!.length; continue }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(rest)
    if (number) { tokens.push({ kind: 'number', value: number[0] }); index += number[0]!.length; continue }
    if (source[index] === '"') {
      let value = ''; let closed = false; index++
      while (index < source.length) {
        if (source[index] !== '"') { value += source[index++]; continue }
        if (source[index + 1] === '"') { value += '"'; index += 2; continue }
        index++; closed = true; break
      }
      if (!closed) throw new Error('unterminated formula string')
      tokens.push({ kind: 'string', value }); continue
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/u.exec(rest)
    if (ident) { tokens.push({ kind: 'ident', value: ident[0]!.toUpperCase() }); index += ident[0]!.length; continue }
    const pair = source.slice(index, index + 2)
    if (['>=', '<=', '<>'].includes(pair)) { tokens.push({ kind: 'op', value: pair }); index += 2; continue }
    const punctuation: Record<string, Token['kind']> = { '(': 'lparen', ')': 'rparen', ',': 'comma', ':': 'colon' }
    if (punctuation[source[index]!]) { tokens.push({ kind: punctuation[source[index]!]! }); index++; continue }
    if ('+-*/=<>'.includes(source[index]!)) { tokens.push({ kind: 'op', value: source[index] }); index++; continue }
    throw new Error(`unsupported formula token at ${index}`)
  }
  tokens.push({ kind: 'eof' })
  return tokens
}

class Parser {
  private index = 0
  constructor(private readonly tokens: Token[]) {}
  private peek() { return this.tokens[this.index]! }
  private take(kind: Token['kind'], value?: string) { const token = this.peek(); if (token.kind !== kind || (value !== undefined && token.value !== value)) throw new Error(`expected ${value ?? kind}`); this.index++; return token }
  parse(): Node { const node = this.comparison(); this.take('eof'); return node }
  private comparison(): Node { let node = this.additive(); while (this.peek().kind === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(this.peek().value!)) { const operator = this.take('op').value!; node = { kind: 'binary', operator, left: node, right: this.additive() } } return node }
  private additive(): Node { let node = this.multiplicative(); while (this.peek().kind === 'op' && ['+', '-'].includes(this.peek().value!)) { const operator = this.take('op').value!; node = { kind: 'binary', operator, left: node, right: this.multiplicative() } } return node }
  private multiplicative(): Node { let node = this.unary(); while (this.peek().kind === 'op' && ['*', '/'].includes(this.peek().value!)) { const operator = this.take('op').value!; node = { kind: 'binary', operator, left: node, right: this.unary() } } return node }
  private unary(): Node { if (this.peek().kind === 'op' && ['+', '-'].includes(this.peek().value!)) { const operator = this.take('op').value as '+' | '-'; return { kind: 'unary', operator, value: this.unary() } } return this.primary() }
  private primary(): Node {
    const token = this.peek()
    if (token.kind === 'number') { this.index++; return { kind: 'literal', value: Number(token.value) } }
    if (token.kind === 'string') { this.index++; return { kind: 'literal', value: token.value ?? '' } }
    if (token.kind === 'cell') { this.index++; const start = token.value!; if (this.peek().kind === 'colon') { this.index++; return { kind: 'range', start, end: this.take('cell').value! } } return { kind: 'cell', coordinate: start } }
    if (token.kind === 'ident') {
      this.index++; const name = token.value!
      if (name === 'TRUE' || name === 'FALSE') return { kind: 'literal', value: name === 'TRUE' }
      this.take('lparen'); const args: Node[] = []
      if (this.peek().kind !== 'rparen') { do { args.push(this.comparison()); if (this.peek().kind !== 'comma') break; this.index++ } while (true) }
      this.take('rparen'); return { kind: 'call', name, args }
    }
    if (token.kind === 'lparen') { this.index++; const node = this.comparison(); this.take('rparen'); return node }
    throw new Error('unsupported formula expression')
  }
}

function splitCoordinate(coordinate: string): { column: number; row: number } { const match = /^([A-Z]{1,3})(\d+)$/u.exec(coordinate); if (!match) throw new Error('invalid cell reference'); let column = 0; for (const char of match[1]!) column = column * 26 + char.charCodeAt(0) - 64; const row = Number(match[2]); if (column < 1 || column > 16_384 || row < 1 || row > 1_048_576) throw new Error('cell reference outside xlsx bounds'); return { column, row } }
function columnName(column: number): string { let value = column, name = ''; while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26) } return name }
function rangeCoordinates(start: string, end: string): string[] { const a = splitCoordinate(start), b = splitCoordinate(end), rowCount = Math.abs(a.row - b.row) + 1, columnCount = Math.abs(a.column - b.column) + 1; if (rowCount * columnCount > 10_000) throw new Error('formula range exceeds acceptance bound'); const result: string[] = []; for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) for (let col = Math.min(a.column, b.column); col <= Math.max(a.column, b.column); col++) result.push(`${columnName(col)}${row}`); return result }
function parseFormula(formula: string): Node { return new Parser(tokenize(formula)).parse() }
function formulaReferences(node: Node, references = new Set<string>()): Set<string> { if (node.kind === 'cell') references.add(node.coordinate); else if (node.kind === 'range') for (const coordinate of rangeCoordinates(node.start, node.end)) references.add(coordinate); else if (node.kind === 'unary') formulaReferences(node.value, references); else if (node.kind === 'binary') { formulaReferences(node.left, references); formulaReferences(node.right, references) } else if (node.kind === 'call') for (const argument of node.args) formulaReferences(argument, references); return references }
function assertReferenceAuthority(formula: string, allowed: ReadonlySet<string>, requireEveryAllowed: boolean): void { const actual = formulaReferences(parseFormula(formula)); for (const reference of actual) if (!allowed.has(reference)) throw new Error(`formula has unrelated dependency: ${reference}`); if (requireEveryAllowed) for (const reference of allowed) if (!actual.has(reference)) throw new Error(`formula omits required dependency: ${reference}`) }
function numeric(value: Scalar): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('formula expected number'); return value }

function evaluate(node: Node, resolve: Resolver): Scalar | Scalar[] {
  if (node.kind === 'literal') return node.value
  if (node.kind === 'cell') return resolve(node.coordinate)
  if (node.kind === 'range') return rangeCoordinates(node.start, node.end).map(resolve)
  if (node.kind === 'unary') { const value = numeric(evaluate(node.value, resolve) as Scalar); return node.operator === '-' ? -value : value }
  if (node.kind === 'binary') {
    const left = evaluate(node.left, resolve) as Scalar, right = evaluate(node.right, resolve) as Scalar
    if (node.operator === '+') return numeric(left) + numeric(right)
    if (node.operator === '-') return numeric(left) - numeric(right)
    if (node.operator === '*') return numeric(left) * numeric(right)
    if (node.operator === '/') return numeric(left) / numeric(right)
    if (node.operator === '=') return left === right
    if (node.operator === '<>') return left !== right
    if (node.operator === '<') return left < right
    if (node.operator === '>') return left > right
    if (node.operator === '<=') return left <= right
    if (node.operator === '>=') return left >= right
    throw new Error('unsupported formula operator')
  }
  const args = node.args.map(arg => evaluate(arg, resolve))
  if (node.name === 'IF') { if (args.length !== 3 || typeof args[0] !== 'boolean') throw new Error('invalid IF'); return args[0] ? args[1] as Scalar : args[2] as Scalar }
  const flattened = args.flatMap(value => Array.isArray(value) ? value : [value]).map(numeric)
  if (node.name === 'SUM') return flattened.reduce((sum, value) => sum + value, 0)
  if (node.name === 'MIN') return Math.min(...flattened)
  if (node.name === 'MAX') return Math.max(...flattened)
  if (node.name === 'AVERAGE') return flattened.reduce((sum, value) => sum + value, 0) / flattened.length
  if (node.name === 'ABS' && flattened.length === 1) return Math.abs(flattened[0]!)
  throw new Error(`formula function ${node.name} is not acceptance-verifiable`)
}

export function evaluateFormula(formula: string, resolve: Resolver): Scalar { const result = evaluate(parseFormula(formula), coordinate => resolve(coordinate.toUpperCase())); if (Array.isArray(result)) throw new Error('formula returned range'); return result }
const sentinel = (coordinate: string, variant: number) => 100_000 + variant * 10_000 + [...coordinate].reduce((sum, char) => sum + char.charCodeAt(0), 0)

export function verifyProfitFormula(formula: string, row: number, revenueColumn: string, costColumn: string, sourceRevenue: number, sourceCost: number): void { const revenueCell = `${revenueColumn}${row}`, costCell = `${costColumn}${row}`; assertReferenceAuthority(formula, new Set([revenueCell, costCell]), true); const probes = [[sourceRevenue, sourceCost], [13, 5], [0, 7], [999, 123], [-4, 9], [100_003, -77]]; for (const [variant, [revenue, cost]] of probes.entries()) { const actual = evaluateFormula(formula, coordinate => coordinate === revenueCell ? revenue : coordinate === costCell ? cost : sentinel(coordinate, variant)); if (actual !== revenue - cost) throw new Error('profit formula semantic mismatch') } }
export function verifyStatusFormula(formula: string, row: number, profitColumn: string, revenueColumn: string, costColumn: string, target: number, sourceProfit: number): void { const profitCell = `${profitColumn}${row}`, revenueCell = `${revenueColumn}${row}`, costCell = `${costColumn}${row}`; assertReferenceAuthority(formula, new Set([profitCell, revenueCell, costCell]), false); const probes = [...new Set([sourceProfit, target - 1000, target - 1, target, target + 1, target + 1000])]; for (const [variant, profit] of probes.entries()) { const cost = 37 + variant; const actual = evaluateFormula(formula, coordinate => coordinate === profitCell ? profit : coordinate === revenueCell ? profit + cost : coordinate === costCell ? cost : sentinel(coordinate, variant)); const expected = profit >= target ? 'On target' : 'Review'; if (actual !== expected) throw new Error('status formula semantic mismatch') } }
export function verifyTotalFormula(formula: string, column: string, rows: readonly number[], sourceValues: readonly number[]): void { if (sourceValues.length !== rows.length) throw new Error('total source vector mismatch'); const expectedReferences = new Set(rows.map(row => `${column}${row}`)); assertReferenceAuthority(formula, expectedReferences, true); const basis = rows.map((_, index) => rows.map((__, candidate) => index === candidate ? 1 : 0)); const vectors = [sourceValues, ...basis, [1, 10, 100].slice(0, rows.length), [5, -2, 7].slice(0, rows.length), rows.map(() => 0), rows.map((_, index) => 100_003 + index * 997)]; for (const [variant, values] of vectors.entries()) { const actual = evaluateFormula(formula, coordinate => { const index = rows.findIndex(row => coordinate === `${column}${row}`); return index >= 0 ? values[index]! : sentinel(coordinate, variant) }); if (actual !== values.reduce((sum, value) => sum + value, 0)) throw new Error('total formula semantic mismatch') } }
