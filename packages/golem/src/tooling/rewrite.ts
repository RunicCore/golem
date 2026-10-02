import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { encodeMappings, type MappingSegment, type SourceMapV3 } from './source-map.js';
import { GOLEM_VERSION } from './version.js';

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

export interface RewriteImport {
  readonly from: string;
  readonly names: readonly string[];
}

export interface RewriteFile {
  readonly sha256: string;
  readonly edits: readonly RewriteEdit[];
  readonly imports: readonly RewriteImport[];
}

/** `files` keys are project-root-relative POSIX paths. */
export interface RewriteIndex {
  readonly version: 1;
  readonly golem: string;
  readonly files: Readonly<Record<string, RewriteFile>>;
}

export class GolemRewriteStaleError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(message);
    this.name = 'GolemRewriteStaleError';
    this.file = file;
  }
}

export const REWRITE_INDEX_PATH = '.golem/rewrites.json';

// Source text, not a regex literal: emit would print a U+2028 escape in a literal as the raw character.
const LINE_BREAK_SOURCE = '\\r\\n|[\\r\\n\\u2028\\u2029]';
const LINE_BREAK = new RegExp(LINE_BREAK_SOURCE, 'g');

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Read `<root>/.golem/rewrites.json`; `undefined` when the file does not exist. */
export function readRewriteIndex(root: string): RewriteIndex | undefined {
  const filename = path.join(root, REWRITE_INDEX_PATH);
  let content: string;
  try {
    content = readFileSync(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const malformed = (): Error => new Error(`golem rewrite index at ${filename} is malformed; run golem generate`);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw malformed();
  }
  const record = value as Partial<Record<keyof RewriteIndex, unknown>> | null;
  if (typeof record !== 'object' || record === null || record.version !== 1 || typeof record.golem !== 'string' || typeof record.files !== 'object' || record.files === null) throw malformed();
  return record as unknown as RewriteIndex;
}

function inconsistent(file: string): Error {
  return new Error(`golem rewrite index is inconsistent for ${file}`);
}

/** Offset after a leading shebang line and `'use strict'` directives. */
function importInsertOffset(text: string): number {
  let offset = 0;
  if (text.startsWith('#!')) {
    LINE_BREAK.lastIndex = 0;
    const lineEnd = LINE_BREAK.exec(text);
    offset = lineEnd ? lineEnd.index + lineEnd[0].length : text.length;
  }
  const directive = new RegExp(`[ \\t]*(['"])use strict\\1[ \\t]*;?[ \\t]*(?:${LINE_BREAK_SOURCE}|$)`, 'y');
  for (;;) {
    directive.lastIndex = offset;
    const match = directive.exec(text);
    if (!match || match[0].length === 0) return offset;
    offset += match[0].length;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The import changes as insertions into the original text, so one edit list drives code and map. */
function importEdits(text: string, imports: readonly RewriteImport[]): RewriteEdit[] {
  const edits: RewriteEdit[] = [];
  for (const { from, names } of imports) {
    const statement = new RegExp(`^[ \\t]*import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${escapeRegExp(from)}\\2`, 'm').exec(text);
    if (statement) {
      const bound = new Set((statement[1] ?? '').split(',').map((specifier) => specifier.trim()).filter(Boolean).map((specifier) => specifier.split(/\s+as\s+/).pop()!.trim()));
      const missing = names.filter((name) => !bound.has(name));
      if (missing.length === 0) continue;
      const list = statement[1] ?? '';
      const listStart = statement.index + statement[0].indexOf('{') + 1;
      const content = list.trimEnd();
      const insertAt = listStart + content.length;
      const joined = missing.join(', ');
      const textToInsert = content === '' ? ` ${joined} ` : content.endsWith(',') ? ` ${joined},` : `, ${joined}`;
      edits.push({ start: insertAt, end: insertAt, expect: '', text: textToInsert });
      continue;
    }
    if (names.length === 0) continue;
    const at = importInsertOffset(text);
    edits.push({ start: at, end: at, expect: '', text: `import { ${names.join(', ')} } from '${from}';\n` });
  }
  return edits;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  LINE_BREAK.lastIndex = 0;
  for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) starts.push(match.index + match[0].length);
  return starts;
}

/**
 * Apply the file's edits and missing imports. Returns `undefined` for a file the
 * index does not list. `file` is the project-root-relative POSIX path.
 */
export function applyRewrites(file: string, text: string, index: RewriteIndex): { readonly code: string; readonly map: SourceMapV3 } | undefined {
  const entry = index.files[file];
  if (!entry) return undefined;
  if (index.golem !== GOLEM_VERSION) {
    throw new GolemRewriteStaleError(file, `rewrite index was written by golem ${index.golem}; run golem generate`);
  }
  if (sha256Hex(text) !== entry.sha256) {
    throw new GolemRewriteStaleError(file, `${file} changed after golem generate; run golem generate, or keep golem watch running.`);
  }

  // Imports first, so an import insertion precedes an edit inserted at the same offset.
  const edits = [...importEdits(text, entry.imports), ...entry.edits]
    .map((edit, order) => ({ edit, order }))
    .sort((a, b) => a.edit.start - b.edit.start || Number(a.edit.end !== a.edit.start) - Number(b.edit.end !== b.edit.start) || a.order - b.order)
    .map(({ edit }) => edit);
  let previousEnd = 0;
  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start > edit.end || edit.end > text.length) throw inconsistent(file);
    if (edit.start < previousEnd || text.slice(edit.start, edit.end) !== edit.expect) throw inconsistent(file);
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
    code,
    map: { version: 3, sources: [file], sourcesContent: [text], names: [], mappings: encodeMappings(lines) },
  };
}
