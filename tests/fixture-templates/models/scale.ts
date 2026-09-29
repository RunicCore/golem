import { identifier, literal, tsSource, type SourceFragment } from '../../source-template.js';

export function scaleModelSource({ index }: { readonly index: number }): SourceFragment {
  const name = identifier(`Item${index}`);
  const generatedModule = literal(`./item-${index}.model.generated.js`);
  return tsSource`import type { IModel } from '@exprtlabs/codegen/model';
import type { MinLength } from '@exprtlabs/codegen/tags';
import { ${name}Base } from ${generatedModule};
export type T${name} = IModel<{ label: string & MinLength<3>; count: number }>;
export class ${name} extends ${name}Base {}`;
}
