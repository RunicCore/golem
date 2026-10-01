import { identifier, literal, tsSource, type SourceFragment } from '../../source-template.js';

export type CompanionModelName = 'Empty' | 'Scalar' | 'Nested';

const fields: Readonly<Record<CompanionModelName, SourceFragment>> = {
  Empty: tsSource`{}`,
  Scalar: tsSource`{ title: string }`,
  Nested: tsSource`{ data: { title: string } }`,
};

export function companionModelSource({ name, mobx }: { readonly name: CompanionModelName; readonly mobx: boolean }): SourceFragment {
  const modelName = identifier(name);
  const generatedModule = literal(`./${name.toLowerCase()}.model.generated.js`);
  const mobxImport = mobx ? tsSource`import { asGenObservable } from '@exprtlabs/golem/mobx';\n` : tsSource``;
  const observable = mobx ? tsSource`    asGenObservable(this);\n` : tsSource``;
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
import { T${modelName}BaseModel, type T${modelName}Fields } from ${generatedModule};
${mobxImport}
export type T${modelName} = IModel<${fields[name]}>;
export class ${modelName} extends T${modelName}BaseModel {
  constructor(values: Partial<T${modelName}Fields> = {}) {
    super(values);
${observable}  }
}
`;
}
