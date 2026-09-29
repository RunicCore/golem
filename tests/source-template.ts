class Fragment {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  get text(): string {
    return this.#text;
  }
}

export type SourceFragment = Fragment;

const reservedBindings = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected',
  'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

export function identifier(value: string): SourceFragment {
  if (typeof value !== 'string') {
    throw new TypeError('Source identifiers must be strings');
  }
  if (!/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(value) || reservedBindings.has(value)) {
    throw new TypeError(`Invalid source identifier: ${JSON.stringify(value)}`);
  }
  return new Fragment(value);
}

export function literal(value: string | number | boolean | null | undefined | bigint): SourceFragment {
  if (value === undefined) return new Fragment('(void 0)');
  if (typeof value === 'bigint') return new Fragment(`${value}n`);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return new Fragment('(0 / 0)');
    if (value === Infinity) return new Fragment('(1 / 0)');
    if (value === -Infinity) return new Fragment('(-1 / 0)');
    if (Object.is(value, -0)) return new Fragment('-0');
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
    throw new TypeError('Source literals must be primitive values');
  }
  return new Fragment(JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'));
}

export function tsSource(strings: TemplateStringsArray, ...values: readonly SourceFragment[]): SourceFragment {
  let text = strings[0];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!(value instanceof Fragment)) throw new TypeError('Source interpolation requires an identifier, literal, or source fragment');
    text += value.text + strings[index + 1];
  }
  return new Fragment(text);
}

export function joinSource(values: readonly SourceFragment[], separator: '\n' | ', ' | '' | ';\n' = '\n'): SourceFragment {
  return new Fragment(values.map(value => {
    if (!(value instanceof Fragment)) throw new TypeError('Source composition requires source fragments');
    return value.text;
  }).join(separator));
}
