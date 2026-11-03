// A test extension with a rewrite participant. It reads calls of declared functions in the source:
//   probeTag()      -> __golem_label("<options.label>:<first line of options.tagFile>"), and the file is one the participant read
//   probeWrap(x)    -> (x): the edit covers the whole call, so it overlaps an edit that core makes inside x
//   probeBad()      -> an error diagnostic PROBE0001
//   probeFail()     -> the participant throws
import fs from 'node:fs';
import path from 'node:path';

export const extension = {
  rewrite({ ts, file, root, options, core }) {
    const edits = [];
    const reads = [];
    const diagnostics = [];
    const replaceCall = (node, text) => {
      const start = node.getStart(file);
      edits.push({ start, end: node.end, expect: file.text.slice(start, node.end), text });
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === 'probeTag') {
          const tagFile = path.resolve(root, options.tagFile);
          reads.push(tagFile);
          core.importName(node, 'label', '@fixture/probe/label');
          replaceCall(node, `__golem_label(${JSON.stringify(`${options.label}:${fs.readFileSync(tagFile, 'utf8').trim()}`)})`);
        } else if (name === 'probeWrap') {
          replaceCall(node, `(${node.arguments[0].getText(file)})`);
        } else if (name === 'probeBad') {
          diagnostics.push(core.locate(node, 'PROBE0001', 'probeBad() is not allowed here'));
        } else if (name === 'probeFail') {
          throw new Error('probe participant exploded');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return { edits, reads, diagnostics };
  },
};
