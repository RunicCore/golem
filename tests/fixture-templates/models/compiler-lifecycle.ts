import { identifier, joinSource, tsSource, type SourceFragment } from '../../source-template.js';

export interface ManifestScaleNames {
  readonly item: string;
  readonly generatedClass: string;
}

function checkedIndex(index: number): ManifestScaleNames {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`Manifest model index must be a non-negative safe integer: ${index}`);
  }
  return {
    item: identifier(`Item${index}`).text,
    generatedClass: identifier(`Item${index}Model`).text,
  };
}

export function manifestScaleNames({ index }: { readonly index: number }): ManifestScaleNames {
  return checkedIndex(index);
}

function manifestScaleTypeSource({ index }: { readonly index: number }): SourceFragment {
  const { item } = checkedIndex(index);
  return tsSource`export interface ${identifier(item)} { value: string }`;
}

/** The SDK model module: the class plus the codec helpers a companion imports for id `scale:item:<index>`. */
export function manifestScaleClassSource({ index }: { readonly index: number }): SourceFragment {
  const { generatedClass } = checkedIndex(index);
  const model = identifier(generatedClass);
  return tsSource`export class ${model} { declare value: string; }
export function ${identifier(`stringifyscale_item_${index}`)}(value: ${model}, _trusted?: unknown): string { return JSON.stringify(value); }
export function ${identifier(`toWireFormatscale_item_${index}`)}(value: ${model}, _trusted?: unknown): object { return { ...value }; }
`;
}

export function manifestScaleTypesSource({ count }: { readonly count: number }): SourceFragment {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`Manifest model count must be a non-negative safe integer: ${count}`);
  }
  const declarations = Array.from({ length: count }, (_, index) => manifestScaleTypeSource({ index }));
  const models = joinSource(declarations);
  return tsSource`/* @golem-model-manifest ./model-manifest.json */
${models}`;
}
