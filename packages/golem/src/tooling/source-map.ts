export interface SourceMapV3 {
  readonly version: 3;
  readonly file?: string;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly names: readonly string[];
  readonly mappings: string;
}

export type MappingSegment = readonly [genCol: number, srcIndex: number, srcLine: number, srcCol: number];

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Map([...BASE64].map((char, index) => [char, index]));

function encodeVlq(value: number): string {
  let rest = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/** Encode per-line segments of absolute `[genCol, srcIndex, srcLine, srcCol]` values. */
export function encodeMappings(lines: readonly (readonly MappingSegment[])[]): string {
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  return lines.map((segments) => {
    let genCol = 0;
    return segments.map((segment) => {
      const encoded = encodeVlq(segment[0] - genCol) + encodeVlq(segment[1] - srcIndex) + encodeVlq(segment[2] - srcLine) + encodeVlq(segment[3] - srcCol);
      [genCol, srcIndex, srcLine, srcCol] = segment;
      return encoded;
    }).join(',');
  }).join(';');
}

/**
 * Decode to per-line segments of absolute values: `[genCol]` for an unmapped
 * segment, `[genCol, srcIndex, srcLine, srcCol]`, or the same plus a name index.
 */
export function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIndex = 0;
  for (const lineText of mappings.split(';')) {
    const segments: number[][] = [];
    let genCol = 0;
    for (const segmentText of lineText === '' ? [] : lineText.split(',')) {
      const fields: number[] = [];
      let shift = 0;
      let accumulator = 0;
      for (const char of segmentText) {
        const digit = BASE64_VALUE.get(char);
        if (digit === undefined) throw new Error(`Invalid source map mappings character '${char}'`);
        accumulator += (digit & 31) * 2 ** shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        const magnitude = Math.floor(accumulator / 2);
        fields.push(accumulator % 2 === 1 ? 0 - magnitude : magnitude);
        shift = 0;
        accumulator = 0;
      }
      if (shift !== 0 || ![1, 4, 5].includes(fields.length)) throw new Error(`Invalid source map segment '${segmentText}'`);
      genCol += fields[0]!;
      const segment = [genCol];
      if (fields.length >= 4) {
        srcIndex += fields[1]!;
        srcLine += fields[2]!;
        srcCol += fields[3]!;
        segment.push(srcIndex, srcLine, srcCol);
      }
      if (fields.length === 5) {
        nameIndex += fields[4]!;
        segment.push(nameIndex);
      }
      segments.push(segment);
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * Compose by position: `outer` maps the rewritten text to the output, `inner`
 * maps the original to the rewritten text; the result maps the original to the
 * output. `outer` describes one source (the rewritten file), so its `sources`
 * naming is ignored; the result's `sources` and `sourcesContent` come from
 * `inner`. Names are dropped. Output segments that land before the first inner
 * segment of their line, or on a line the inner map does not cover, are dropped.
 */
export function composeSourceMaps(outer: SourceMapV3, inner: SourceMapV3): SourceMapV3 {
  const innerLines = decodeMappings(inner.mappings).map((line) => line.filter((segment) => segment.length >= 4));
  const lines = decodeMappings(outer.mappings).map((line) => {
    const composed: MappingSegment[] = [];
    for (const segment of line) {
      if (segment.length < 4) continue;
      const rewrittenLine = innerLines[segment[2]!];
      if (!rewrittenLine) continue;
      const rewrittenCol = segment[3]!;
      let index = -1;
      for (let low = 0, high = rewrittenLine.length - 1; low <= high;) {
        const middle = (low + high) >> 1;
        if (rewrittenLine[middle]![0]! <= rewrittenCol) { index = middle; low = middle + 1; } else high = middle - 1;
      }
      const start = rewrittenLine[index];
      if (!start) continue;
      // Only an unchanged run advances alike on both sides; text inserted or replaced by an edit maps to its start.
      const next = rewrittenLine[index + 1];
      const linear = !next || (next[1] === start[1] && next[2] === start[2] && next[3]! - start[3]! === next[0]! - start[0]!);
      composed.push([segment[0]!, start[1]!, start[2]!, start[3]! + (linear ? rewrittenCol - start[0]! : 0)]);
    }
    return composed;
  });
  return {
    version: 3,
    ...(outer.file === undefined ? {} : { file: outer.file }),
    sources: inner.sources,
    ...(inner.sourcesContent === undefined ? {} : { sourcesContent: inner.sourcesContent }),
    names: [],
    mappings: encodeMappings(lines),
  };
}
