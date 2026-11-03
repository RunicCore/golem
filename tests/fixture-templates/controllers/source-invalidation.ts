import { literal, tsSource, type SourceFragment } from '../../source-template.js';

export function sourceInvalidationModule(options: { readonly value: string }): SourceFragment {
  return tsSource`export const name = ${literal(options.value)};`;
}
