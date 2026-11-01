// The rule the docs job gives the model analysis for a controller DTO field: the Swagger `@ApiProperty` that states a schema, and the RUNM1086 error for a Map or Set.
import * as ts from '@exprtlabs/golem/internal/ts';
import { decoratorIdentity, diagnostic, type DtoRule } from '@exprtlabs/golem/internal/type-analysis';
import { DECORATOR_PACKAGES, NEST_SWAGGER } from './packages.js';

/** The RUNM1086 message; only a class field can take the `@ApiProperty` advice. */
function mapOrSetDtoMessage(where: string, collection: string, decoratable: boolean): string {
  return `${where} is a ${collection}. JSON writes a ${collection} as {}, so no schema describes it. `
    + (decoratable ? 'Give the field an @ApiProperty with type, schema or additionalProperties, or use a Record or an array.' : 'Use a Record or an array.');
}

/** True when the property has `@ApiProperty` or `@ApiPropertyOptional` of `@nestjs/swagger` with a `type`, `schema` or `additionalProperties` the user wrote. */
function carriesExplicitSwaggerSchema(checker: ts.TypeChecker, property: ts.Symbol): boolean {
  return (property.declarations ?? []).some(declaration => ts.canHaveDecorators(declaration) && (ts.getDecorators(declaration) ?? []).some(decorator => {
    if (!ts.isCallExpression(decorator.expression)) return false;
    const { name, packageName } = decoratorIdentity(checker, decorator, DECORATOR_PACKAGES);
    if (packageName !== NEST_SWAGGER || (name !== 'ApiProperty' && name !== 'ApiPropertyOptional')) return false;
    const [options] = decorator.expression.arguments;
    return options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some(item => (
      (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item))
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
      && ['type', 'schema', 'additionalProperties'].includes(item.name.text)
    ));
  }));
}

/** The rule of the docs job: a field with a written Swagger schema is an open object, and a Map or Set field stops with RUNM1086. */
export const swaggerDtoRule: DtoRule = {
  statesSchema: carriesExplicitSwaggerSchema,
  mapOrSetError: (sourceFile, node, where, collection, decoratable) => diagnostic(sourceFile, node, '1086', mapOrSetDtoMessage(where, collection, decoratable)),
};
