import { tsSource, type SourceFragment } from '../../source-template.js';

export function prototypeFieldsModelSource(options: {
  readonly mobx: boolean;
}): SourceFragment {
  const mobxImport = options.mobx
    ? tsSource`import { asGenObservable } from '@exprtlabs/codegen/mobx';\n`
    : tsSource``;
  const mobxInitialization = options.mobx ? tsSource`\n    asGenObservable(this);` : tsSource``;
  return tsSource`import type { IModel } from '@exprtlabs/codegen/model';
import { ItemBase, type ItemFields } from './item.model.generated.js';
${mobxImport}export type TItem = IModel<{
  label: string;
  dictionary: Record<string, string>;
  nested: { value: number };
}>;
export class Item extends ItemBase {
  constructor(values: Partial<ItemFields> = {}) {
    super(values);
    ${mobxInitialization}
  }
}
`;
}
