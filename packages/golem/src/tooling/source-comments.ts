import type * as ts from './typescript-ns.js';

/** One comment of a source text: `pos` is the offset of its opening `//` or `/*`, `end` the offset after it. A line comment does not hold its line break. */
export interface SourceComment {
  readonly block: boolean;
  readonly pos: number;
  readonly end: number;
}

/**
 * Every comment of `file`, in order, from the compiler's own scanner. The scanner cannot tell a regular expression or a template
 * from code without the parser, so it never reads those: the nodes that hold such text (string, template, regular expression and JSX
 * text tokens) are left out, and the text between them is scanned. No other token of a TypeScript file holds a `//` or a `/*`.
 */
export function sourceComments(compiler: typeof ts, file: ts.SourceFile): SourceComment[] {
  const { SyntaxKind } = compiler;
  const opaque = new Set<number>([SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail, SyntaxKind.RegularExpressionLiteral, SyntaxKind.JsxText]);
  const gaps: { start: number; end: number }[] = [];
  let from = 0;
  const visit = (node: ts.Node): void => {
    if (opaque.has(node.kind)) {
      gaps.push({ start: from, end: node.getStart(file) });
      from = node.end;
      return;
    }
    compiler.forEachChild(node, (child) => { visit(child); });
  };
  visit(file);
  gaps.push({ start: from, end: file.text.length });

  const comments: SourceComment[] = [];
  for (const { start, end } of gaps) {
    const scanner = compiler.createScanner(false, file.text, start, end - start);
    // The scanner ends at the end of its range; the two compilers name that token differently, so the loop reads the position.
    do {
      const kind = scanner.scan();
      if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
        comments.push({ block: kind === SyntaxKind.MultiLineCommentTrivia, pos: scanner.getTokenStart(), end: scanner.getTokenEnd() });
      }
    } while (scanner.getTokenEnd() < end);
  }
  return comments;
}
