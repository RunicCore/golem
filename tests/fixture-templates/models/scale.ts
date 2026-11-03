import { identifier, literal, tsSource, type SourceFragment } from '../../source-template.js';

export function scaleModelSource({ index }: { readonly index: number }): SourceFragment {
  const name = identifier(`Item${index}`);
  const generatedModule = literal(`./item-${index}.model.generated.js`);
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { T${name}BaseModel } from ${generatedModule};
export type T${name} = IModel<{ label: string & MinLength<3>; count: number }>;
export class ${name} extends T${name}BaseModel {}`;
}
