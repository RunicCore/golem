// The packages whose decorators the nest extension and the docs job read.
/** The package of the framework decorators (`@Controller`, `@Body`, `@Version`). */
export const NEST_COMMON = '@nestjs/common' as const;
/** The package of the Swagger decorators (`@ApiProperty`, `@ApiOperation`). */
export const NEST_SWAGGER = '@nestjs/swagger' as const;
/** The package of the stamp decorators that the rewrite writes. */
export const OWN_PACKAGE = '@exprtlabs/golem-ts-openapi' as const;
/** The packages that `decoratorIdentity` and `decoratorPackageOf` name a decorator by. */
export const DECORATOR_PACKAGES: readonly string[] = [NEST_COMMON, NEST_SWAGGER];
