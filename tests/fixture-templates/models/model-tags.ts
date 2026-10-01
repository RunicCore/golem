import { identifier, literal, tsSource, type SourceFragment } from '../../source-template.js';

export interface TaggedModelSourceOptions {
  readonly name: string;
  readonly fields: SourceFragment;
  readonly options?: SourceFragment;
  readonly imports?: SourceFragment;
}

export function taggedModelSource({ name, fields, options, imports }: TaggedModelSourceOptions): SourceFragment {
  const modelName = identifier(name);
  const baseName = identifier(`${name}BaseModel`);
  const fieldsName = identifier(`${name}Fields`);
  const typeName = identifier(`T${name}`);
  const generatedModule = literal(`./${name.toLowerCase()}.model.generated.js`);
  const typeOptions = options ? tsSource`, ${options}` : tsSource``;
  const importPrelude = imports ? tsSource`${imports}\n` : tsSource``;
  return tsSource`${importPrelude}import type { IModel } from '@exprtlabs/golem/model';
import { ${baseName}, type ${fieldsName} } from ${generatedModule};
export type ${typeName} = IModel<{ ${fields} }${typeOptions}>;
export class ${modelName} extends ${baseName} {
  constructor(values: Partial<${fieldsName}> = {}) { super(values); }
}
`;
}
