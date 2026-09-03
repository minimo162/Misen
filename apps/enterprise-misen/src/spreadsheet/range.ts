export interface RangeBoundaries {
  readonly minRow: number
  readonly maxRow: number
  readonly minCol: number
  readonly maxCol: number
}

const COORDINATE = /^([A-Z]{1,3})([1-9]\d{0,6})$/iu

export function columnName(column: number): string {
  if (!Number.isSafeInteger(column) || column < 1 || column > 16_384) throw new RangeError('column is outside Excel bounds')
  let value = column
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + value % 26) + result
    value = Math.floor(value / 26)
  }
  return result
}

export function splitCoordinate(coordinate: string): { readonly row: number; readonly col: number } {
  const match = COORDINATE.exec(coordinate.trim())
  if (!match) throw new Error('invalid cell coordinate: ' + coordinate)
  let col = 0
  for (const character of match[1]!.toUpperCase()) col = col * 26 + character.charCodeAt(0) - 64
  const row = Number(match[2])
  if (col > 16_384 || row > 1_048_576) throw new RangeError('cell coordinate is outside Excel bounds: ' + coordinate)
  return { row, col }
}

export function tupleToCoordinate(col: number, row: number): string {
  if (!Number.isSafeInteger(row) || row < 1 || row > 1_048_576) throw new RangeError('row is outside Excel bounds')
  return columnName(col) + row
}

export function rangeBoundaries(range: string): RangeBoundaries {
  const parts = range.trim().split(':')
  if (parts.length < 1 || parts.length > 2) throw new Error('invalid range: ' + range)
  const start = splitCoordinate(parts[0]!)
  const end = splitCoordinate(parts[1] ?? parts[0]!)
  return {
    minRow: Math.min(start.row, end.row),
    maxRow: Math.max(start.row, end.row),
    minCol: Math.min(start.col, end.col),
    maxCol: Math.max(start.col, end.col),
  }
}

export function rangeCoordinates(range: string, maximum = 10_000): string[] {
  const bounds = rangeBoundaries(range)
  const count = (bounds.maxRow - bounds.minRow + 1) * (bounds.maxCol - bounds.minCol + 1)
  if (count > maximum) throw new RangeError('range exceeds ' + maximum + ' cells')
  const result: string[] = []
  for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
    for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) result.push(tupleToCoordinate(col, row))
  }
  return result
}
