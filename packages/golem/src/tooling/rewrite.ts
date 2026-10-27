import { isAbsolute } from 'node:path';
import { encodeMappings, type MappingSegment, type SourceMapV3 } from './source-map.js';
import { displayPath } from './generator-api.js';

export interface RewriteEdit {
  /** UTF-16 offset into the original file text. */
  readonly start: number;
  /** Exclusive; `start === end` for insertions. */
  readonly end: number;
  /** Original text at `[start, end)`; `''` for insertions. */
  readonly expect: string;
  /** Replacement. */
  readonly text: string;
}

/**
 * A module and the names `applyRewrites` imports from it. Each name is imported
 * under the alias `__golem_<name>`, so edit text refers to `__golem_<name>(...)`
 * and cannot clash with, or depend on, the file's own imports. An entry with no
 * names is a side-effect import: it loads the module and binds nothing.
 */
export interface RewriteImport {
  readonly from: string;
  readonly names: readonly string[];
}

/** What a host does to one file: the edits, the aliased imports they need, and where those imports go. */
export interface FileRewrite {
  readonly edits: readonly RewriteEdit[];
  readonly imports: readonly RewriteImport[];
  /** UTF-16 offset in the original text, after a leading shebang and the directive prologue. Read only when `imports` is not empty. */
  readonly importsAt: number;
}

export const REWRITE_IMPORT_PREFIX = '__golem_';

// Source text, not a regex literal: emit would print a U+2028 escape in a literal as the raw character.
const LINE_BREAK_SOURCE = '\\r\\n|[\\r\\n\\u2028\\u2029]';
const LINE_BREAK = new RegExp(LINE_BREAK_SOURCE, 'g');

const BYTE_ORDER_MARK = '\uFEFF';

/** The text as the compiler sees it: without a leading U+FEFF. */
function withoutByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

/** Names the file when the caller knows it, and the line of the edit's start in `text`. */
function inconsistent(edit: RewriteEdit, text: string, file: string | undefined): Error {
  const starts = lineStarts(text);
  const at = Number.isInteger(edit.start) ? Math.min(Math.max(edit.start, 0), text.length) : 0;
  const line = starts.filter((start) => start <= at).length;
  return new Error(`golem rewrite is inconsistent${file === undefined ? '' : ` for ${displayPath(file)}`} at line ${line}: the edit at ${edit.start}-${edit.end} is out of range, overlaps another edit, or no longer matches the text it expects; run golem generate`);
}

const QUOTE_ESCAPED = new RegExp("[\\\\'\\n\\r\\u2028\\u2029]", 'g');
const QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\u2028': '\\u2028', '\u2029': '\\u2029',
};

/** `from` as a single-quoted string literal. */
function quote(from: string): string {
  return `'${from.replace(QUOTE_ESCAPED, (character) => QUOTE_ESCAPES[character]!)}'`;
}

/**
 * One aliased import line per entry, inserted at `at`, after a leading shebang and the
 * directive prologue. Existing imports are never read or edited.
 */
function importEdits(text: string, imports: readonly RewriteImport[], at: number): RewriteEdit[] {
  const lineBreakBefore = at === 0 || '\r\n\u2028\u2029'.includes(text.charAt(at - 1));
  return imports.map(({ from, names }, position) => ({
    start: at,
    end: at,
    expect: '',
    text: `${position === 0 && !lineBreakBefore ? '\n' : ''}import ${names.length === 0 ? '' : `{ ${names.map((name) => `${name} as ${REWRITE_IMPORT_PREFIX}${name}`).join(', ')} } from `}${quote(from)};\n`,
  }));
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  LINE_BREAK.lastIndex = 0;
  for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) starts.push(match.index + match[0].length);
  return starts;
}

/**
 * Apply a file's edits and missing imports. Offsets are UTF-16 units of `text`
 * as the compiler sees it: a leading U+FEFF is not counted and is kept in the
 * output. The map's one source is named `''` and holds the text without the
 * mark; a host that knows the file name sets `sources`. `file`, when given,
 * is an absolute path and names the file in the error of an inconsistent rewrite.
 */
export function applyRewrites(source: string, rewrite: FileRewrite, file?: string): { readonly code: string; readonly map: SourceMapV3 } {
  if (file !== undefined && !isAbsolute(file)) throw new Error(`Internal error: applyRewrites names its file by an absolute path, got ${file}.`);
  const text = withoutByteOrderMark(source);
  const mark = source.slice(0, source.length - text.length);

  // Imports first, so an import insertion precedes an edit inserted at the same offset.
  const edits = [...importEdits(text, rewrite.imports, rewrite.importsAt), ...rewrite.edits]
    .map((edit, order) => ({ edit, order }))
    .sort((a, b) => a.edit.start - b.edit.start || Number(a.edit.end !== a.edit.start) - Number(b.edit.end !== b.edit.start) || a.order - b.order)
    .map(({ edit }) => edit);
  let previousEnd = 0;
  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start > edit.end || edit.end > text.length) throw inconsistent(edit, text, file);
    if (edit.start < previousEnd || text.slice(edit.start, edit.end) !== edit.expect) throw inconsistent(edit, text, file);
    previousEnd = edit.end;
  }

  const sourceLineStarts = lineStarts(text);
  const sourcePosition = (offset: number): { line: number; col: number } => {
    let low = 0;
    let high = sourceLineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (sourceLineStarts[middle]! <= offset) low = middle; else high = middle - 1;
    }
    return { line: low, col: offset - sourceLineStarts[low]! };
  };

  const lines: MappingSegment[][] = [[]];
  let genCol = 0;
  let code = '';
  // Text maps run by run: every piece starts a segment, and so does every line it begins inside.
  const emit = (piece: string, sourceOffset: number, advances: boolean): void => {
    if (piece === '') return;
    const segment = (offset: number): void => {
      const { line, col } = sourcePosition(offset);
      lines[lines.length - 1]!.push([genCol, 0, line, col]);
    };
    segment(sourceOffset);
    let pieceStart = 0;
    LINE_BREAK.lastIndex = 0;
    for (let match = LINE_BREAK.exec(piece); match; match = LINE_BREAK.exec(piece)) {
      pieceStart = match.index + match[0].length;
      lines.push([]);
      genCol = 0;
      if (pieceStart < piece.length) segment(advances ? sourceOffset + pieceStart : sourceOffset);
    }
    genCol += piece.length - pieceStart;
    code += piece;
  };

  let cursor = 0;
  for (const edit of edits) {
    emit(text.slice(cursor, edit.start), cursor, true);
    emit(edit.text, edit.start, false);
    cursor = edit.end;
  }
  emit(text.slice(cursor), cursor, true);

  return {
    code: `${mark}${code}`,
    map: { version: 3, sources: [''], sourcesContent: [text], names: [], mappings: encodeMappings(lines) },
  };
}
