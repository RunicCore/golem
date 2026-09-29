import { identifier, literal, tsSource, type SourceFragment } from './source-template.js';

function modelSource(options: { readonly name: string; readonly limit: number }): SourceFragment {
  return tsSource`export class ${identifier(options.name)} { readonly limit = ${literal(options.limit)}; }`;
}

// These calls are checked by build:tests; deliberately invalid inputs never execute.
function templateTypeContracts(): void {
  modelSource({ name: 'Example', limit: 3 });
  // @ts-expect-error template parameter limit must be numeric
  modelSource({ name: 'Example', limit: '3' });
  // @ts-expect-error raw strings cannot be interpolated as source
  tsSource`const value = ${'unsafe'};`;
  // @ts-expect-error numbers need explicit literal encoding
  tsSource`const value = ${3};`;
  // @ts-expect-error objects cannot masquerade as source fragments
  tsSource`const value = ${{ text: 'unsafe' }};`;
  // @ts-expect-error source literal values cannot be objects
  literal({ value: 3 });
}

void templateTypeContracts;
