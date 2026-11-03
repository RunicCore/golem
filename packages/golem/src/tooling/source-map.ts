import { displayPath, errorMessage } from './generator-core.js';

// Source text, not a regex literal: emit would print a U+2028 escape in a literal as the raw character.
const LINE_BREAK_SOURCE = '\\r\\n|[\\r\\n\\u2028\\u2029]';
export const LINE_BREAK = new RegExp(LINE_BREAK_SOURCE, 'g');

export function lineStarts(text: string): number[] {
  const starts = [0];
  LINE_BREAK.lastIndex = 0;
  for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) starts.push(match.index + match[0].length);
  return starts;
}

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
 * The place in the original for a position of the rewritten text, from the segments of the map of that rewrite (those with a source):
 * `[srcIndex, srcLine, srcCol]`, or nothing when the map does not cover the line or starts after the column. Only an unchanged run advances
 * alike on both sides; text inserted or replaced by an edit maps to its start.
 */
function locate(lines: readonly (readonly (readonly number[])[])[], line: number, col: number): readonly [number, number, number] | undefined {
  const segments = lines[line];
  if (!segments) return undefined;
  let index = -1;
  for (let low = 0, high = segments.length - 1; low <= high;) {
    const middle = (low + high) >> 1;
    if (segments[middle]![0]! <= col) { index = middle; low = middle + 1; } else high = middle - 1;
  }
  const start = segments[index];
  if (!start) return undefined;
  const next = segments[index + 1];
  const linear = !next || (next[1] === start[1] && next[2] === start[2] && next[3]! - start[3]! === next[0]! - start[0]!);
  return [start[1]!, start[2]!, start[3]! + (linear ? col - start[0]! : 0)];
}

const mappedSegments = (mappings: string): number[][][] => decodeMappings(mappings).map((line) => line.filter((segment) => segment.length >= 4));

/**
 * Compose by position: `outer` maps the rewritten text to the output, `inner`
 * maps the original to the rewritten text; the result maps the original to the
 * output. `outer` describes one source (the rewritten file), so its `sources`
 * naming is ignored; the result's `sources` and `sourcesContent` come from
 * `inner`. Names are dropped. Output segments that land before the first inner
 * segment of their line, or on a line the inner map does not cover, are dropped.
 */
export function composeSourceMaps(outer: SourceMapV3, inner: SourceMapV3): SourceMapV3 {
  const innerLines = mappedSegments(inner.mappings);
  const lines = mappedSegments(outer.mappings).map((line) => {
    const composed: MappingSegment[] = [];
    for (const segment of line) {
      const original = locate(innerLines, segment[2]!, segment[3]!);
      if (original) composed.push([segment[0]!, ...original]);
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

/** The map the compiler wrote, read as JSON: a text that is not JSON is named by its file, not left as a bare SyntaxError. */
function parseEmittedMap(text: string, filename: string): SourceMapV3 {
  try {
    return JSON.parse(text) as SourceMapV3;
  } catch (error) {
    throw new Error(`golem build: the source map ${displayPath(filename)} that the compiler wrote is not JSON: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Point the JSON text of a map the compiler made for a rewritten file at the original: `inner` is the rewrite map of that file. Every
 * field the compiler wrote stays as it wrote it (`file`, `sourceRoot`, `sources`) except the mappings, which now name positions of the original,
 * the names, which the composition drops, and the embedded sources, which are the original text and not the rewritten one.
 */
export function pointSourceMap(text: string, inner: SourceMapV3, filename: string): string {
  const emitted = parseEmittedMap(text, filename);
  return JSON.stringify({
    ...emitted,
    names: [],
    mappings: composeSourceMaps(emitted, inner).mappings,
    ...(emitted.sourcesContent === undefined ? {} : { sourcesContent: inner.sourcesContent }),
  });
}

/**
 * Point the JSON text of a declaration map at the declaration after an edit of its text: `edit` is the rewrite map of the declaration, which maps
 * the edited text to the text the compiler wrote. The edit moves the generated side of the compiler's map, where the rewrite of a JavaScript file
 * moves its source side, so each segment keeps its original and finds its place in the edited text. Every field the compiler wrote stays as it wrote it
 * (`file`, `sourceRoot`, `sources`, `sourcesContent`) except the mappings and the names, which the move drops.
 */
export function pointDeclarationMap(text: string, edit: SourceMapV3, filename: string): string {
  const emitted = parseEmittedMap(text, filename);
  // The edit read the other way: from a position of the compiler's text to its position in the edited text.
  const edited: number[][][] = [];
  decodeMappings(edit.mappings).forEach((line, editedLine) => {
    for (const segment of line) if (segment.length >= 4) (edited[segment[2]!] ??= []).push([segment[3]!, 0, editedLine, segment[0]!]);
  });
  for (const line of edited) line?.sort((left, right) => left[0]! - right[0]!);
  const lines: MappingSegment[][] = [];
  mappedSegments(emitted.mappings).forEach((line, written) => {
    for (const segment of line) {
      const place = locate(edited, written, segment[0]!);
      if (place) (lines[place[1]] ??= []).push([place[2], segment[1]!, segment[2]!, segment[3]!]);
    }
  });
  for (const line of lines) line?.sort((left, right) => left[0] - right[0]);
  return JSON.stringify({ ...emitted, names: [], mappings: encodeMappings(Array.from(lines, (line) => line ?? [])) });
}

const SOURCE_MAP_COMMENT = '//# sourceMappingURL=';

/**
 * The JavaScript text of `file` that the compiler wrote with a map file, carrying `mapText` as an inline source map instead. The compiler's last line names
 * its map file; that line, and nothing else, is the place of the data URL, and the end of the text after it stays as the compiler wrote it. A text that does not end in
 * that line is an error that names the file.
 */
export function inlineEmittedSourceMap(file: string, code: string, mapText: string): string {
  const start = code.lastIndexOf(SOURCE_MAP_COMMENT);
  if (start < 0 || (start > 0 && code[start - 1] !== '\n')) throw new Error(`golem build could not find the source map comment at the end of ${file}.`);
  const url = code.slice(start + SOURCE_MAP_COMMENT.length).trimEnd();
  if (url === '' || url.includes('\n')) throw new Error(`golem build could not find the source map comment at the end of ${file}.`);
  const ending = code.slice(start + SOURCE_MAP_COMMENT.length + url.length);
  return `${code.slice(0, start)}${SOURCE_MAP_COMMENT}data:application/json;base64,${Buffer.from(mapText, 'utf8').toString('base64')}${ending}`;
}
