import { code, identifier as identifierCode, literal as literalCode, type Code } from '../code.js';
import type { IrValidationImport } from './ir.js';

/** Module-level state the function bodies add to while they are emitted. */
export class ModuleState {
  private readonly declarations: Code[] = [];
  /** The name of each declared constant, by what it holds: one constant serves every use of the same value. */
  private readonly constants = new Map<string, Code>();
  private imports: readonly IrValidationImport[] = [];

  public importValidations(imports: readonly IrValidationImport[]): void {
    this.imports = imports;
  }

  /** The local name of the validation function at `index` of the module's imports. */
  public validationFunction(index: number): Code {
    return identifierCode(`v${index}`);
  }

  /**
   * Declares a module-level constant and returns its name. A constant that holds the same value, as `key` says, is
   * declared once. Every initializer is a call or a `new`, so it carries the annotation that lets a bundler drop the
   * constant with the validator that alone uses it; a call among its arguments carries the annotation too, as a bundler
   * keeps a pure call whose arguments may have side effects. An expression that holds a runtime part has no text to
   * compare, so every constant comes with its `key`.
   */
  public constant(prefix: string, expression: Code, key: string): Code {
    const identity = `${prefix}\u0000${key}`;
    const known = this.constants.get(identity);
    if (known !== undefined) return known;
    const name = identifierCode(`${prefix}${this.declarations.length}`);
    this.declarations.push(code`const ${name} = /*#__PURE__*/ ${expression};`);
    this.constants.set(identity, name);
    return name;
  }

  /** The import line of each validation function the module calls. */
  public validationImports(): readonly Code[] {
    return this.imports.map((entry, index) => {
      const exported = /^[A-Za-z_$][\w$]*$/.test(entry.exportName) ? identifierCode(entry.exportName) : literalCode(entry.exportName);
      return code`import { ${exported} as ${this.validationFunction(index)} } from ${literalCode(entry.importPath)};`;
    });
  }

  /** The declaration of each module-level constant. */
  public constantDeclarations(): readonly Code[] {
    return this.declarations;
  }
}

/** The module constant that holds the regular expression of `pattern`; it has no `g` flag, so a test leaves no `lastIndex`. */
export function patternExpression(state: ModuleState, pattern: string): Code {
  return state.constant('pattern', code`new RegExp(${literalCode(pattern)}, 'u')`, pattern);
}
