# Diagnostics

Find what a generator error code means and how to fix it.

An error prints its code, location when known, and message, then stops generation; a warning prints the same and lets generation continue, as its entry below notes. The printed line may also carry a severity word next to the code.

## Controller generator (NEST)

### NEST1001

**No exported controllers.** No exported class decorated with `@Controller` exists among the configured source files. **Fix:** Export at least one `@Controller` class, or point `context.sources` at the files that declare it.

### NEST1002

**No controller sources.** No `*.controller.ts` file exists under `src`, and `context.sources` was not provided. **Fix:** Add a `*.controller.ts` file, or pass `context.sources` explicitly.

### NEST1004

**Unsupported type.** A controller type resolves to something the schema converter can't represent, such as a function or a class-instance value rather than plain data. **Fix:** Replace it with a plain object, array, or primitive shape.

### NEST1101

**Unsupported Nest parameter.** A parameter decorator injects Nest-specific runtime state that has no OpenAPI mapping — `@UploadedFile()`, `@UploadedFiles()`, `@RawBody()`, `@HostParam()` — or `@Res()`/`@Response()` is used without the setup OpenAPI needs: non-inline options, or no explicit Swagger success response. **Fix:** Remove the decorator and describe the value through a supported parameter or body, or for `@Res()` write `{ passthrough: true }` inline or add an explicit Swagger success response.

### NEST1102

**Unrepresentable Nest parameter.** A `@nestjs/common` parameter decorator this generator doesn't recognize is present — not a location decorator (`@Body`, `@Query`, `@Param`, `@Headers`) and not one of the explicitly unsupported ones. **Fix:** Remove the decorator, or replace it with a supported one.

### NEST1103

**Named body parameter.** `@Body('field')` names a single field instead of the whole request body. **Fix:** Use `@Body()` for the whole object and declare an explicit request-body contract.

### NEST1105

**Unknown parameter keys.** Flattening a whole `@Query()`/`@Param()`-style object fails because its type has an index signature, so its full set of keys isn't statically known. **Fix:** Declare named fields instead of an index signature, or name the parameter explicitly (`@Query('name')`) so it isn't flattened.

### NEST1106

**Non-primitive parameter.** Flattening a whole-object parameter finds no representable properties on it. **Fix:** Give the parameter object primitive properties to flatten, or name it explicitly and describe it with `@ApiQuery`, `@ApiParam`, or `@ApiHeader`.

### NEST1107

**Non-portable parameter.** A parameter's OpenAPI mapping isn't portable for the shape or version involved: flattening it would need a non-primitive property, a named parameter isn't primitive, a whole `@Query()` object collides with another query parameter, or a `querystring` parameter needs OpenAPI 3.2.0. **Fix:** Use a named primitive parameter or an explicit Swagger contract, keep a single whole-object query parameter, or generate against OpenAPI 3.2.0 for a `querystring` parameter.

### NEST1108

**Lossy query flatten.** OpenAPI 3.1.2 flattens a whole `@Query()` object into independent parameters, and this object's constraints or codecs can't survive that. **Fix:** Generate against OpenAPI 3.2, which keeps a whole query object as one `querystring` schema, or declare a named primitive query contract.

### NEST1201

**Unsupported route decorator.** A route decorator, or one of its options, has no OpenAPI representation — an unsupported method decorator such as `@All()` or `@Sse()`, an unmapped `@RequestMapping({ method })`, or a non-constant option on a route-level decorator such as `@Header()` or `@Version()`. **Fix:** Exclude the route with `@ApiExcludeEndpoint()`, use a supported HTTP method decorator, or make the decorator's option a compile-time constant.

### NEST1202

**Version without URI routing.** A method or class declares `@Version()`, but the generator's `uriVersioning` option isn't URI versioning, so the version has no distinct OpenAPI path. **Fix:** Set `uriVersioning: { type: 'URI' }` in the generation context, or remove `@Version()`.

### NEST1203

**Unsupported versioning type.** `uriVersioning` names a Nest versioning type other than `'URI'`. **Fix:** Set `uriVersioning` to `'URI'`, or an object with `type: 'URI'`.

### NEST1204

**Invalid versioning options.** `uriVersioning` is neither omitted nor an object describing URI versioning. **Fix:** Pass an object such as `{ type: 'URI', prefix: 'v', defaultVersion: '1' }`, or omit it.

### NEST1205

**Unsupported versioning mode.** `uriVersioning.type` names something other than URI versioning. **Fix:** Remove `uriVersioning.type`, or set it to `'URI'`; the static Nest adapter supports only URI versioning.

### NEST1206

**Host-based routing.** `@Controller({ host })` routes by request host, which has no portable OpenAPI path. **Fix:** Remove `host` from the `@Controller()` options and route by path instead.

### NEST1207

**Unsupported route path.** The route path uses `path-to-regexp` syntax OpenAPI paths can't express — wildcards, regular-expression parameters, quoted names, or more than 4 optional segments. **Fix:** Rewrite the path with plain `{param}`-style segments, splitting differing cases into separate routes; exclude the route with `@ApiExcludeEndpoint()` if it can't be rewritten.

### NEST1301

**Unsupported parameter location.** A parameter resolves to a location other than path, query, header, or cookie. **Fix:** Remove the parameter, or give it a supported location decorator (`@Param`, `@Query`, `@Headers`).

### NEST1302

**Missing parameter name.** A path, query, header, or cookie parameter has no name. **Fix:** Give the parameter a name, such as `@Param('id')` or `@ApiQuery({ name: 'id' })`.

### NEST1303

**Missing path parameter.** The route path has a `{placeholder}` with no matching `@Param()` declaration. **Fix:** Add the missing `@Param()` parameter, or remove the placeholder from the path.

### NEST1304

**Unsupported HTTP method.** The route resolves to an HTTP method OpenAPI's path item doesn't support. **Fix:** Use one of Nest's standard method decorators: `@Get`, `@Post`, `@Put`, `@Delete`, `@Patch`, `@Options`, or `@Head`.

### NEST1305

**Duplicate operation ID.** Two routes produce the same `operationId`, whether inferred from the method name or set explicitly. **Fix:** Set distinct `@ApiOperation({ operationId })` values, or change the route so the inferred name differs.

### NEST1306

**Duplicate route.** Two routes declare the same HTTP method and path after expanding versions and optional segments. **Fix:** Change one route's path or method, or remove the duplicate.

### NEST1307

**Extra path parameter.** `@Param('name')` names a path segment the route path doesn't declare. **Fix:** Remove the parameter, or add `{name}` to the route path.

### NEST1308

**Duplicate response status.** Two response declarations claim the same status for one operation. **Fix:** Remove or merge the duplicate response decorator so each status appears once.

### NEST1309

**Invalid response status.** A response status isn't a valid HTTP status — not an integer from 100 through 599, `default`, or `1XX` through `5XX` — or a response decorator isn't `@ApiResponse` or a recognized named helper. **Fix:** Use a real status code (or `1XX`–`5XX`, `default`), and use `@ApiResponse` or a supported named helper.

### NEST1310

**Primitive response metadata.** The response is a file, stream, `Observable`, or other primitive type without an explicit Swagger response, leaving nothing to build a schema from. **Fix:** Add an explicit Swagger response decorator with `content`, `schema`, or `type` describing that response.

### NEST1311

**Conflicting response status.** An explicit Swagger success status conflicts with Nest's actual runtime success status for the method — for example `@ApiOkResponse()` documenting `200` on a `@Post()`, which Nest runs as `201`. **Fix:** Add `@HttpCode(status)` to change Nest's runtime status to match, or change the Swagger response status to match Nest's runtime status.

### NEST1312

**Duplicate parameter.** The same parameter (name and location) is declared more than once for one operation, or a whole `@Query()` object is declared alongside another whole-object or named query parameter. **Fix:** Remove the duplicate, or combine the fields into one contract.

### NEST1401

**Invalid info.** `context.info`, or its `title`/`version` field, is missing, not an object, or not a non-empty string. **Fix:** Pass `info: { title, version }` with non-empty strings.

### NEST1402

**Unsupported OpenAPI version.** `context.openapiVersion` names something other than `'3.2.0'` or `'3.1.2'`. **Fix:** Set `openapiVersion` to `'3.2.0'` or `'3.1.2'`, or omit it to use the default.

### NEST1403

**Invalid server.** A `context.servers` entry doesn't match the OpenAPI Server Object shape — a non-object entry, an unsupported property, a missing or empty `url`, or a `variables` entry whose `default` isn't a string included in its `enum`. **Fix:** Shape each server as `{ url, description?, variables? }`, and make sure a variable's `default` is one of its `enum` values.

### NEST1404

**Invalid security scheme.** A security scheme in `context.securitySchemes` doesn't match its type's OpenAPI shape — an unsupported `type`, an unsupported property for that type, or an OAuth2 flow missing a required URL or `scopes`. **Fix:** Match the OpenAPI Security Scheme Object for the chosen `type` (`apiKey`, `http`, `mutualTLS`, `oauth2`, or `openIdConnect`).

### NEST1405

**Invalid security requirement.** A route's security requirement names a scheme that isn't in `context.securitySchemes`, its scopes aren't an array of strings, or `@ApiSecurity()` doesn't resolve to a scheme name or a record of scheme scopes. **Fix:** Add the scheme to `context.securitySchemes`, or fix the `@ApiSecurity()` or security requirement shape.

### NEST1501

**No schema resolver.** The document builder needs a canonical schema for a type, but no `schemaResolver` was supplied in the build context. **Fix:** Pass a `schemaResolver`, or generate through `@exprtlabs/golem-ts-openapi/generator`, which always supplies one.

### NEST1502

**Non-portable schema.** A field's custom executable validation can't be expressed as a static OpenAPI schema keyword. This is a warning: generation continues without that rule. **Fix:** Document the constraint by hand in the API contract if a client needs to see it.

### NEST1503

**Conflicting schema metadata.** Static Swagger metadata — a `required` flag, a `schema`, or an `@ApiProperty()` option — contradicts the schema golem-ts-openapi derived from the TypeScript or IModel contract. **Fix:** Change the Swagger option, or the TypeScript type, so the two describe the same shape and requiredness.

### NEST1504

**Unsupported schema metadata.** A decorator option isn't a compile-time constant — it reads a variable, calls a function, or spreads a non-static value — or it names a schema in a way generation can't resolve, such as a `getSchemaPath()`, `refs()`, or `enumName` collision. **Fix:** Write the decorator's options inline as literal values, and give `getSchemaPath()` and `enumName` unique component names.

### NEST1505

**Unresolved schema reference.** The generated OpenAPI document has a `$ref` to a component schema that isn't present among the document's schemas. **Fix:** Make sure the referenced class, or `getSchemaPath()` name, is used by (or explicitly referenced from) a controller route.

## Model generator (RUNM)

### RUNM1001

**Missing fields type.** `IModel` has no type argument for its fields. **Fix:** Give it one, such as `IModel<{ name: string }>`.

### RUNM1002

**Unexported model alias.** An `IModel` or `IObject` type alias isn't exported. **Fix:** Export the type alias.

### RUNM1003

**Unsupported TypeScript type.** A model or field type isn't one of the shapes this generator can convert — none of the recognized primitive, literal, array, tuple, object, or union forms. **Fix:** Replace it with a supported shape, such as a plain object, array, primitive, or named model reference.

### RUNM1004

**Callable or constructible type.** A model, or one of its fields, resolves to a type with call or construct signatures — a function or a class-instance shape rather than plain data. **Fix:** Replace it with a plain object, array, or primitive.

### RUNM1005

**Duplicate generated model name.** Two `IModel`/`IObject` declarations in the same model source produce the same generated name. **Fix:** Rename one of the declarations.

### RUNM1011

**Field contains any.** A field's type includes `any`, and the model doesn't allow it. **Fix:** Replace it with a concrete type or `unknown`, or allow it with `{ allowAny: true }` as `IModel`'s second type argument, or `allowAny: true` in `golem.yaml`.

### RUNM1021

**Unsupported tuple rest element.** A tuple's rest element isn't a concrete array type, or is an unresolved generic variadic. **Fix:** Give the rest element a concrete array type.

### RUNM1030

**Ambiguous generated-model union.** A union that mixes a generated OpenAPI model with other alternatives can't be told apart reliably: it has more than one generated-model alternative, an alternative that's `any`, `unknown`, an array, or an intersection, or its object alternatives share no unique required literal discriminator. **Fix:** Keep one generated-model alternative, use a primitive or a uniquely tagged object branch alongside it, and give shared-shape object alternatives a required literal discriminator.

### RUNM1040

**Unresolvable tag function.** `TValidation`'s predicate, or `TSerde`'s `serialize`/`deserialize` argument, names a declaration the checker can't resolve, or the resolved function isn't exported. **Fix:** Point the tag at an exported function.

### RUNM1041

**Invalid TValidation argument.** `TValidation`'s type argument isn't `typeof` an exported synchronous predicate. **Fix:** Pass `typeof yourPredicate`, where `yourPredicate` is exported and synchronous.

### RUNM1042

**Invalid TSerde arguments.** `TSerde` is missing its `serialize` or `deserialize` type argument, or one of them isn't `typeof` a function. **Fix:** Pass `typeof serialize` and `typeof deserialize` for both arguments.

### RUNM1043

**Invalid constraint argument.** A constraint tag's type argument doesn't match what that tag needs: a finite numeric literal for `Minimum`, `Maximum`, `MultipleOf` and similar tags, a non-negative integer for length and count tags, a positive number for `MultipleOf`, or a representable schema type for `Contains`, `PropertyNames`, `AdditionalProperties`, and the other schema-valued tags. **Fix:** Give the tag the literal or schema shape its reference describes.

### RUNM1044

**Invalid string or pattern argument.** A tag needing a string literal (`Format`, `DependentRequired`'s keys) got something else, or `Pattern`'s argument isn't a valid Unicode regular expression. **Fix:** Pass a string literal, or a pattern `new RegExp(pattern, 'u')` accepts.

### RUNM1045

**Unintersected tag.** A constraint, `TValidation`, or `TSerde` tag appears on its own instead of intersected with a model value type. **Fix:** Intersect the tag with the field's type, such as `string & MinLength<1>`.

### RUNM1046

**Invalid tag function signature.** `TValidation`'s predicate, `TSerde`'s `serialize`, or `TSerde`'s `deserialize` isn't a single callable function, or doesn't accept exactly one required parameter. **Fix:** Give the function exactly one required parameter and no overloads.

### RUNM1047

**Asynchronous tag function.** `TValidation`'s predicate, or `TSerde`'s `serialize`/`deserialize`, returns a thenable. **Fix:** Make the function synchronous.

### RUNM1048

**Invalid validation return type.** `TValidation`'s predicate doesn't return `boolean`, `string`, or a union of the two. **Fix:** Return `boolean` or `string` (or a union of them) synchronously.

### RUNM1049

**Incompatible serde type.** A `TSerde` binding's `serialize` parameter, `serialize` result, or `deserialize` result isn't assignable to the type it needs to match against the field. **Fix:** Change the `serialize`/`deserialize` signatures, or the field's type, so they agree.

### RUNM1050

**Incompatible validation parameter.** A `TValidation` predicate's parameter type isn't assignable from the field's type. **Fix:** Widen the predicate's parameter type, or narrow the field's type, so the predicate accepts it.

### RUNM1051

**Incompatible constraint.** `MinContains`/`MaxContains` appears without a `Contains` constraint on the same value, or a constraint's family (number, string, array, or object) doesn't match the type it tags. **Fix:** Add a `Contains` constraint alongside `MinContains`/`MaxContains`, or apply the constraint to a value of the matching type.

### RUNM1052

**Root IModel union.** `IModel`'s fields type is a union, such as `IModel<TEmail | TPhone>`. **Fix:** Put the union in a named field instead of at the model's root, or declare separate models.

### RUNM1053

**Unnamed nested IModel.** A field's type traces to an `IModel`/`IObject` definition that isn't a named, exported declaration. **Fix:** Give the nested model its own named, exported type alias.

### RUNM1054

**Ambiguous model identity.** More than one model specification structurally matches a composed field type, and the type isn't a union. **Fix:** Reference one model explicitly instead of relying on structural matching.

### RUNM1055

**Lossy derived type.** A derived type built with `Pick`, `Omit`, or `Partial` would discard the source model's whole-object constraints, validation, or custom serde. **Fix:** Declare an explicit contract for the derived shape instead of deriving one from the whole model.

### RUNM1056

**Unresolvable recursive object.** An anonymous object type refers back to itself with nothing to break the cycle: no named model, and no derived-type contract for it. **Fix:** Give the recursive shape a named model, or declare it as an explicit derived type.

### RUNM1057

**Generic IModel declaration.** An `IModel`/`IObject` type alias declares its own type parameters. **Fix:** Put generic wrappers outside `IModel`, and instantiate them in a concrete, non-generic model declaration.

### RUNM1058

**Unresolved contract type.** A field's type resolves to TypeScript's internal error type because its declaration or import couldn't be resolved. **Fix:** Fix the declaration or import before generating.

### RUNM1059

**Generated type name clash.** Two different inline types derive the same generated name, such as `Omit<TMerchant, 'id'>` over two unrelated `TMerchant` types, or an inline type whose derived name is also the name of a model. The message lists both places. **Fix:** Declare a named type alias for one of the inline types, for example `type TBillingMerchant = Omit<TMerchant, 'id'>`, and use it in the field.

### RUNM1060

**Codec not exported by its package.** A `TSerde` or `TValidation` function, or a `TSerde` class, lives in another package, and no `exports` entry in that package's `package.json` reaches its file. The message names the function, the package and the file. **Fix:** Add an `exports` entry for that file to the package.

### RUNM1061

**Function reference through a type parameter.** A `TSerde` or `TValidation` inside a type alias receives its function through the alias's type parameter. **Fix:** Write `typeof` an exported function directly in the alias.

### RUNM1062

**Repeated tag in a generic alias.** A type alias holds more than one tag of the same kind, and one of them depends on a type parameter. **Fix:** Keep one tag of that kind in the alias, and add the other where you use the alias.

### RUNM1063

**Class cannot be imported.** A `TSerde` field holds a class that generated code cannot import and name: an anonymous class, a class that its module doesn't export, a generic class with a type parameter that has no default, or a class declared inside `declare module "name"`. The message names the class and the file. **Fix:** Name the class and export it from a module file, or declare a non-generic subclass such as `class StringBox extends Box<string> {}` and use that. A class exported under another name or as the default export needs no change.

### RUNM1064

**Tag hidden behind another alias.** A type alias passes its type parameter to a tag through a second alias, such as `type Inner<N extends number> = MaxLength<N>` used in `type V<N extends number> = string & Inner<N>`, so the generator can't find the tag on the instantiated type. **Fix:** Write the tag directly in the alias that declares the type parameter.

### RUNM1065

**Codec or predicate declared in a model file.** A `TSerde` or `TValidation` function is declared in a `*.model.ts` or `*.models.ts` file. Generated code imports the function, and the model file imports its `*.model.generated.ts` file, so the two import each other; when the generated file loads first, the model class extends a base class that isn't initialized yet and start-up fails. **Fix:** Move the function to its own module, export it there, and import it into the model file.

### RUNM1066

**Serde type argument is not a type name.** A call to `stringify`, `parse`, `validate`, `assertValue`, `toWireFormat` or `fromWireFormat` has a type argument that is not a single type name or `typeof` expression, such as `parse<TPayment | null>(text)`, `parse<Array<TPayment>>(text)` or `parse<TPayment, TMoney>(text)`. The message names the function and the position of the call, and `golem check` and every host report it. **Fix:** Pass one model type alias, one model class, or `typeof` an exported codec, and declare a named model for a union or generic.

### RUNM1067

**Serde type argument has no codec.** The type argument of a serde call names something that is no model: a type parameter, a type that no `IModel` or `IObject` declares, or a name that several models share. The message shows the call, such as `parse<T> has no unique codec id`. **Fix:** Name an exported `IModel` or `IObject` alias. Inside a generic function, take the codec as a parameter instead of a type parameter; golem rewrites a call only where the model is known when it generates.

### RUNM1068

**Reserved name in a rewritten file.** A file that holds a serde call or a model class uses an identifier that starts with `__golem_`, which golem reserves for the imports it adds to that file, so a local with that name would capture the rewritten call. The message names the identifier. **Fix:** Rename the identifier.

### RUNM1069

**Class imported from two modules.** A file holds `parse` or `fromWireFormat` calls whose type arguments are type-only imports of two classes with the same exported name from different modules. golem imports each of them by name for the call, and a name has one module. **Fix:** Import one of the classes as a value, or give the two classes different names.

### RUNM1070

**Rewrite site outside the project root.** A file that the TypeScript project includes but that lies outside the directory of its tsconfig holds a serde call with a type argument, or a class that extends a generated model base class. A rewrite names its file by a path from that directory, so no host can rewrite it. `golem check` and every host report it; the message names the file and the line. `golem check` and `golem build` skip a workspace package that the project reaches through `node_modules`, since that package's own `golem build` rewrites it; the loader and the plugins follow the [symlink rule](/reference/runtime-api#register). **Fix:** Move the file under the tsconfig's directory, or point `tsconfig` in `golem.yaml` at a tsconfig whose directory contains it.

### RUNM1071

**Nest parameter type has no codec.** A `@Body()` or `@Query()` parameter's type is a model (an `IModel` or `IObject` alias, or a class that extends a generated base class), but golem finds no single generated model for it. Either the model is new and `golem generate` has not run since, or two models in different files share the name and the type is not one of them. The message shows the decorator and the type, such as `@Body() type Payment has no unique codec id; run golem generate`. **Fix:** Run `golem generate`. If the error stays, type the parameter with the exported `IModel` or `IObject` alias or the model class, imported from the file that declares it.

### RUNM1072

**Nest parameter disagrees with the generated operations.** `golem check` found a `@Body()` or `@Query()` parameter whose model is missing from `src/generated/operation-codecs.ts`, or that file does not exist. The controllers job writes that file from the routes it reads, so the parameter is not part of a route it generated. The message shows the decorator and the type. **Fix:** Run `golem generate`. If the parameter belongs to a method that is not a route, add its file to the controllers job's `sources`, or give the parameter a primitive type.

## Validators (VALIDATE)

The validator compiler writes the checks that generated models and SDKs run. Its messages name the document, the schema and the JSON pointer of the keyword it rejects, such as `orders.yaml: schema "Order" at /properties/total/pattern: ...`. An error stops generation before any validator is written; a warning lets generation continue, as its entry notes.

### VALIDATE_INVALID_PATTERN

**Invalid regular expression.** A `pattern` keyword, or a key of `patternProperties`, is not a valid regular expression. golem reads each one as a JavaScript expression with the `u` flag, so `\p{L}` is valid, but an unterminated `[`, a lone `{` or a `\-` outside a character class is not. The message shows the pattern and the reason JavaScript gives. **Fix:** Correct the expression so that `new RegExp(pattern, 'u')` accepts it.

### VALIDATE_REF_CYCLE

**Reference cycle.** A chain of `$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else` or `dependentSchemas` keywords returns to a schema without reading any property or item of the value, so a check could never finish. A cycle that goes through a property or an item, such as a tree whose `children` are trees, is fine. The message points at the first `$ref` in the cycle. **Fix:** Break the cycle, or make the schema read a property or an item before it refers back to itself.

### VALIDATE_UNKNOWN_FORMAT

**Format golem does not check.** A `format` keyword names a format that golem does not implement. golem checks `date-time`, `date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uuid`, `regex`, `int32`, `int64`, `float` and `double`. By default this is a warning: generation continues and values are not checked against that format. With `unknownFormats: error` in [golem.yaml](/reference/config#root-keys) it is an error. **Fix:** Use an implemented format, or remove the `format` keyword and state the rule with `pattern`. Set `unknownFormats: error` to find every such format.

### VALIDATE_UNKNOWN_VALIDATION

**Validation function not found.** A model refers to a validation function (a `TValidation` predicate) that the generator did not hand to the compiler to import. The message shows the function's identifier. **Fix:** Export the function from a source file that the job reads, then run `golem generate` again. The predicate must also meet the rules in [RUNM1040](#runm1040).

### VALIDATE_UNRESOLVED_REF

**Reference that does not resolve.** A `$ref` points at a schema that the document does not hold, such as `#/$defs/missing` or an identifier that no schema declares. The message shows the reference. **Fix:** Correct the pointer or the identifier, or add the schema it names.

### VALIDATE_UNSUPPORTED_KEYWORD

**Keyword golem does not support.** A schema uses `$dynamicRef` or `$dynamicAnchor`. Dynamic references depend on the order in which a validator reaches a schema at run time, which golem's validators do not track, so ignoring them would accept data that the schema rejects. Annotation keywords and keywords that start with `x-` are ignored without a diagnostic. **Fix:** Replace the dynamic reference with a `$ref` to a named schema.

## Client generator (OPENAPI)

### OPENAPI_BROWSER_COOKIE

**Browser-inaccessible cookie.** An operation has a `cookie` parameter, or uses a security scheme that's an API key sent through a cookie; browsers don't let scripts set the `Cookie` header, so a client generated for the browser can't supply it there. This is a warning: generation continues. **Fix:** Call this operation from a non-browser client, or move the parameter or security scheme to a header or query location if it must work from a browser.

### OPENAPI_DISCRIMINATOR_IMPLICIT_VALUE

**Implicit discriminator value.** A discriminated-union variant has no explicit `discriminator.mapping` entry, so it's selected by its raw component name — which differs from the generated model name. This is a warning: generation continues, and decoding still works using the raw component name as the implicit value. **Fix:** Add an explicit `mapping` entry if the wire value should differ from the raw component name.

### OPENAPI_DISCRIMINATOR_INHERITANCE_UNSUPPORTED

**Unsupported discriminator inheritance.** A schema declares a `discriminator` without `oneOf`/`anyOf` — the pattern for selecting a subtype through `allOf` inheritance. This is a warning: generation continues, but a subtype that extends the schema through `allOf` is never selected when the base type is decoded. **Fix:** Restructure the schema as a `oneOf`/`anyOf` with `discriminator`, if a subtype needs to be selected on decode.

### OPENAPI_DISCRIMINATOR_NOT_LOWERED

**Discriminator unusable for conversion.** A schema has a `discriminator` with `oneOf`/`anyOf`, but not every variant resolves to an exact component-schema reference — for example, an inline variant. This is a warning: generation continues, but the discriminator isn't used to pick a variant when decoding. **Fix:** Make every `oneOf`/`anyOf` variant an exact `$ref` to a component schema.

### OPENAPI_OPERATION_RENAMED

**Operation renamed.** The generated operation name is a JavaScript reserved word or an existing client member name (such as `constructor`), so the generator appends its allocator's suffix to make it distinct. This is a warning: generation continues, but the operation's exported name no longer matches its `operationId` or inferred name. **Fix:** Give the operation an `operationId` that isn't a JavaScript reserved word or client member name, if you need the two to match exactly.

### OPENAPI_UNION_SHARED_VARIANT

**Shared union variant.** A `oneOf`/`anyOf` variant schema is also claimed by another union, so no single class can represent it as a subtype of both; the generator emits no union model class for this schema. This is a warning: generation continues, and values still decode to their variant model classes — they don't gain the shared union's own class. **Fix:** Give the variant to a single union in the OpenAPI document if it needs a dedicated union class.
