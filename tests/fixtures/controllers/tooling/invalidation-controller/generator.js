import fs from 'node:fs';

const options = JSON.parse(fs.readFileSync(new URL('./provider-options.json', import.meta.url), 'utf8'));

export const apiVersion = 1;

export function generate(context) {
  fs.appendFileSync(options.orderLogPath, 'controller,');
  fs.appendFileSync(options.logPath, context.info.title + ',');
  context.onInput(options.sharedInputPath);
  return {
    artifacts: [{
      path: context.output,
      content: JSON.stringify({ 'x-generator': '@exprtlabs/ts-to-openapi', title: context.info.title }),
    }],
    manifestPaths: [],
    watchInputs: context.sources,
  };
}
