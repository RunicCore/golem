# Diagnostics

Find what a generator error code means and how to fix it.

An error prints its code, location when known, and message, then stops generation; a warning prints the same and lets generation continue, as its entry below notes. The printed line may also carry a severity word next to the code. A file in a message is relative to the working directory.

## Controller generator (NEST)

### NEST1001

**No exported controllers.** No exported class decorated with `@Controller` exists among the configured source files. **Fix:** Export at least one `@Controller` class, or list the files that declare it in `sources` of the controller job. When you call `generate` in code, pass them as its `sources` option.

### NEST1002

**No controller sources.** No file that ends in one of the controller `suffixes` (default `.controller.ts`) exists under `src` of the job `root`, and the controller job has no `sources`. **Fix:** Add a controller file, or list the controller files in `sources` of the controller job. When you call `generate` in code, pass them as its `sources` option.

### NEST1101

**Unsupported Nest parameter.** A parameter decorator injects Nest-specific runtime state that has no OpenAPI mapping. Cases:

- `@UploadedFile()`, `@UploadedFiles()`, `@RawBody()` or `@HostParam()` is used.
- `@Res()` or `@Response()` is used without the setup OpenAPI needs: non-inline options, or no explicit Swagger success response.

**Fix:**

- Remove the decorator and describe the value through a supported parameter or body.
- For `@Res()`, write `{ passthrough: true }` inline, or add an explicit Swagger success response.

### NEST1102

**Unrepresentable Nest parameter.** A `@nestjs/common` parameter decorator this generator doesn't recognize is present — not a location decorator (`@Body`, `@Query`, `@Param`, `@Headers`) and not one of the explicitly unsupported ones. **Fix:** Remove the decorator, or replace it with a supported one.

### NEST1103

**Named body parameter.** A `@Body` parameter is not valid in these cases:

- A one-field `@Body('field')` has a type that is no `IModel`, `IObject` or array of them.
- A one-field `@Body('field')` is optional.
- A one-field `@Body('field')` shares an operation with a whole `@Body()`.
- A second whole `@Body()` in the same method.

`NestModelInterceptor` converts only a model field, and it cannot convert a whole body and a field of it together.

**Fix:**

- Give the field a required `IModel` or `IObject` type, or an array of one.
- Or use `@Body()` for the whole object and declare an explicit request-body contract.
- Use one-field parameters only, or one whole parameter only.
- Declare the body as one model when a method has two whole `@Body()` parameters.

### NEST1105

**Unknown parameter keys.** Flattening a whole `@Query()`/`@Param()`-style object fails because its type has an index signature, so its full set of keys isn't statically known. **Fix:** Declare named fields instead of an index signature, or name the parameter explicitly (`@Query('name')`) so it isn't flattened.

### NEST1106

**Non-primitive parameter.** Flattening a whole-object parameter finds no representable properties on it. **Fix:** Give the parameter object primitive properties to flatten, or name it explicitly and describe it with `@ApiQuery`, `@ApiParam`, or `@ApiHeader`.

### NEST1107

**Non-portable parameter.** A parameter's OpenAPI mapping isn't portable for the shape or version involved. Cases:

- Flattening it would need a non-primitive property.
- A named parameter is neither primitive nor, for `@Query('name')`, an `IModel` or `IObject`.
- A one-field `@Query('name')` model is optional, is an array of models, or holds an array field.
- A whole `@Query()` object shares an operation with a one-field model, or collides with another query parameter.
- A `querystring` parameter needs OpenAPI 3.2.0.

**Fix:**

- Use a named primitive parameter or an explicit Swagger contract.
- Keep a single whole-object query parameter.
- Generate against OpenAPI 3.2.0 for a `querystring` parameter.

### NEST1108

**Lossy query flatten.** OpenAPI 3.1.2 flattens a whole `@Query()` object into independent parameters, and this object's constraints or codecs can't survive that. A union of models can't survive it either. **Fix:** Use OpenAPI 3.2, which writes a querystring parameter, or declare one model for the query.

### NEST1201

**Unsupported route decorator.** A route decorator, or one of its options, has no OpenAPI representation. Cases:

- An unsupported method decorator such as `@All()` or `@Sse()`.
- An unmapped `@RequestMapping({ method })`.
- A non-constant option on a route-level decorator such as `@Header()` or `@Version()`.
- A route method with a computed name, such as `[NAME]()`.

**Fix:**

- Exclude the route with `@ApiExcludeEndpoint()`.
- Or use a supported HTTP method decorator.
- Or make the decorator's option a compile-time constant.
- Or give a route method an identifier name.

### NEST1202

**Version without URI routing.** A method or class declares `@Version()`, but `uriVersioning` of the controller job isn't URI versioning, so the version has no distinct OpenAPI path. **Fix:** Set `uriVersioning: { type: URI }` in the controller job, or remove `@Version()`.

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

### NEST1313

**Duplicate controller name.** Two controller classes with the same name, in different files, each declare a method of the same name, and `@ApiOperation({ operationId })` keeps their operation IDs apart. Golem names a method by its class and method name, so one method would replace the other, and `golem check` would report a wrong [`RUNM1072`](#runm1072) for the other class.

**Fix:** Rename one controller class.

### NEST1401

**Invalid info.** `info` of the controller job, or its `title` or `version` field, is missing, not an object, or not a non-empty string. **Fix:** Set `info` with a `title` and a `version` that are non-empty strings.

### NEST1402

**Unsupported OpenAPI version.** `openapiVersion` of the controller job names something other than `'3.2.0'` or `'3.1.2'`. **Fix:** Set `openapiVersion` to `'3.2.0'` or `'3.1.2'`, or omit it to use the default.

### NEST1403

**Invalid server.** A `servers` entry of the controller job doesn't match the OpenAPI Server Object shape. Cases:

- A non-object entry.
- An unsupported property.
- A missing or empty `url`.
- A `name` on OpenAPI 3.1.2, or the same `name` on two servers of OpenAPI 3.2.0.
- A `variables` entry whose `default` isn't a string included in its `enum`.

**Fix:**

- Shape each server as `{ url, description?, variables? }`, with a unique `name?` on OpenAPI 3.2.0 only.
- Make a variable's `default` one of its `enum` values.

### NEST1404

**Invalid security scheme.** A security scheme in `securitySchemes` of the controller job doesn't match its type's OpenAPI shape — an unsupported `type`, an unsupported property for that type, or an OAuth2 flow missing a required URL or `scopes`. **Fix:** Match the OpenAPI Security Scheme Object for the chosen `type` (`apiKey`, `http`, `mutualTLS`, `oauth2`, or `openIdConnect`).

### NEST1405

**Invalid security requirement.** A route's security requirement names a scheme that isn't in `securitySchemes` of the controller job, its scopes aren't an array of strings, or `@ApiSecurity()` doesn't resolve to a scheme name or a record of scheme scopes. **Fix:** Add the scheme to `securitySchemes`, or fix the `@ApiSecurity()` or security requirement shape.

### NEST1501

**No schema resolver.** The document builder needs a canonical schema for a type, but no `schemaResolver` was supplied in the build context. A `golem.yaml` job never causes this error, because the generator always supplies one. Only a tool that calls the builder without a `schemaResolver` sees it.

**Fix:**

- Pass a `schemaResolver`.
- Or generate through `@exprtlabs/golem-ts-openapi/generator`.

### NEST1502

**Non-portable schema.** A field's custom executable validation can't be expressed as a static OpenAPI schema keyword. This is a warning: generation continues without that rule. **Fix:** Document the constraint by hand in the API contract if a client needs to see it.

### NEST1503

**Conflicting schema metadata.** Static Swagger metadata — a `required` flag, a `schema`, or an `@ApiProperty()` option — contradicts the schema golem-ts-openapi derived from the TypeScript or IModel contract. **Fix:** Change the Swagger option, or the TypeScript type, so the two describe the same shape and requiredness.

### NEST1504

**Unsupported schema metadata.** A decorator option isn't a compile-time constant — it reads a variable, calls a function, or spreads a non-static value — or it names a schema in a way generation can't resolve, such as a `getSchemaPath()`, `refs()`, or `enumName` collision. **Fix:** Write the decorator's options inline as literal values, and give `getSchemaPath()` and `enumName` unique component names.

### NEST1505

**Unresolved schema reference.** The generated OpenAPI document has a `$ref` to a component schema that isn't present among the document's schemas. **Fix:** Make sure the referenced class, or `getSchemaPath()` name, is used by (or explicitly referenced from) a controller route.

## Route evaluation (RUNT)

### RUNT2101

**Unsupported route expression.** Golem cannot fold a route path or version in a controller decorator to a string or an array of strings at generation time. It folds string literals, `+` and template strings, constants, and helpers with a single `return` statement. It stops at a value that is not constant, a helper with more than one statement or a rest parameter, a call with the wrong number of arguments, or a helper that calls itself or nests more than 64 calls. **Fix:** Write the path as a string literal, an array of string literals, or a helper that returns one value, as in [route helpers](/reference/nestjs#route-helpers).

### RUNT2106

**Route result too large.** A route path or version folds to a value larger than the limit, 1 MiB when written as JSON. **Fix:**

- Use a shorter path or version value.
- Or raise `maxResultBytes` in the [controller job](/reference/config#controller-jobs) of `golem.yaml`.

## Model generator (RUNM)

### RUNM1001

**Missing fields type.** `IModel` has no type argument for its fields. **Fix:** Give it one, such as `IModel<{ name: string }>`.

### RUNM1002

**Unexported model alias.** An `IModel` or `IObject` type alias isn't exported. **Fix:** Export the type alias.

### RUNM1003

**Unsupported TypeScript type.** A model or field type isn't one of the shapes this generator can convert — none of the recognized primitive, literal, array, tuple, object, or union forms. The message names the type and the field. **Fix:** Replace it with a supported shape, such as a plain object, array, primitive, or named model reference.

### RUNM1004

**Callable or constructible type.** A model, or one of its fields, resolves to a type with call or construct signatures — a function or a class-instance shape rather than plain data. A model field typed `Map`, `Set`, `ReadonlyMap` or `ReadonlySet` stops here too, and the message names the type. With validation off, only the callable case does not stop. **Fix:** Replace it with a plain object, array, or primitive. Replace a `Map` with a `Record<string, V>` and a `Set` with an array.

### RUNM1005

**Duplicate generated model name.** Two `IModel`/`IObject` declarations in the same model source produce the same generated name, or two models of one model source get the same OpenAPI component name, from `@ApiSchema({ name })` or a class name.

**Fix:**

- Rename one of the declarations.
- For a component name, give one class another `@ApiSchema({ name })`, or move it to another file.

### RUNM1011

**Field contains any or unknown.** A field's type includes `any` or `unknown`, and the model doesn't allow it. The check includes the parameter of a `TSerde` deserializer. **Fix:** Replace it with a concrete type, or allow it with `{ allowAny: true }` as `IModel`'s second type argument, or `allowAny: true` in `golem.yaml`.

### RUNM1021

**Unsupported tuple rest element.** A tuple's rest element isn't a concrete array type, or is an unresolved generic variadic. **Fix:** Give the rest element a concrete array type.

### RUNM1030

**Ambiguous generated-model union.** A union that mixes a generated OpenAPI model with other alternatives can't be told apart reliably. Cases:

- It has more than one generated-model alternative.
- An alternative is `any`, `unknown`, an array, or an intersection.
- Its object alternatives share no unique required literal discriminator.

**Fix:**

- Keep one generated-model alternative.
- Use a primitive or a uniquely tagged object branch alongside it.
- Give shared-shape object alternatives a required literal discriminator.

### RUNM1040

**Unresolvable tag function.** `TValidation`'s predicate, or `TSerde`'s `serialize`/`deserialize` argument, names a function that golem cannot use. Cases:

- The checker can't resolve the declaration.
- The resolved function isn't exported.
- Two functions in one field share one function type, such as two consts typed by the same alias, so golem cannot tell which one the tag names.

**Fix:**

- Point the tag at an exported function.
- When two functions share a type, declare one with `function` or give it its own type.

### RUNM1041

**Invalid TValidation argument.** `TValidation`'s type argument isn't `typeof` an exported synchronous predicate. **Fix:** Pass `typeof yourPredicate`, where `yourPredicate` is exported and synchronous.

### RUNM1042

**Invalid TSerde arguments.** `TSerde` is missing its `serialize` or `deserialize` type argument, or one of them isn't `typeof` a function. **Fix:** Pass `typeof serialize` and `typeof deserialize` for both arguments.

### RUNM1043

**Invalid constraint argument.** A constraint tag's type argument doesn't match what that tag needs:

- A finite numeric literal for `Minimum`, `Maximum`, `MultipleOf` and similar tags.
- A non-negative integer for length and count tags.
- A positive number for `MultipleOf`.
- A representable schema type for `Contains`, `PropertyNames`, `AdditionalProperties`, and the other schema-valued tags.

**Fix:** Give the tag the literal or schema shape its reference describes.

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

**IModel fields type is not an object type.** `IModel`'s or `IObject`'s fields type is a union, an array, a tuple, a `Date`, a function, a scalar, or an intersection with one of these, such as `IModel<TEmail | TPhone>` or `IModel<string[]>`. The message names what it found.

**Fix:**

- Declare the fields in an object type.
- Put the union, array or scalar in a named field, or declare separate models.

### RUNM1053

**Unnamed nested IModel.** A field's type traces to an `IModel`/`IObject` definition that isn't a named, exported declaration, such as `IObject<{ text: string }>` written inside a union. The message gives the position of that definition and shows its text. **Fix:** Give the nested model its own named, exported type alias.

### RUNM1054

**Ambiguous model identity.** More than one model specification structurally matches a composed field type, and the type isn't a union. **Fix:** Reference one model explicitly instead of relying on structural matching.

### RUNM1055

**Lossy derived type.** A derived type built with `Pick`, `Omit`, or `Partial` would discard the source model's whole-object constraints, validation, or custom serde. **Fix:** Declare an explicit contract for the derived shape instead of deriving one from the whole model.

### RUNM1056

**Unresolvable recursive type.** A type refers back to itself, and golem cannot give the cycle a name. A recursive type gets its name from its interface, class or type alias, so the cycle needs one of them.

**Fix:**

- Declare the recursive shape as a named interface, class or type alias, for example `type Tree = { children: Tree[] }`.
- Or declare it as a named model.

### RUNM1057

**Generic IModel declaration.** An `IModel`/`IObject` type alias declares its own type parameters. **Fix:** Put generic wrappers outside `IModel`, and instantiate them in a concrete, non-generic model declaration.

### RUNM1058

**Unresolved contract type.** A field has TypeScript's internal error type, because golem could not resolve a declaration or an import. The message adds the first TypeScript error at that position, such as `(TS2304: Cannot find name 'strin'.)`, when there is one. Golem reports this code in these cases:

- The fields type of an `IModel` or `IObject` cannot be resolved, such as `IModel<Missing>` with a broken import.
- A `Pick` names a member that its source type does not declare.
- A model is defined by a mapped type over its own class, such as `IModel<{ [K in keyof Customer]: Customer[K] }>` where `Customer` extends the generated base of that model. The base is generated from the model, so the type has no members.

**Fix:**

- Fix the declaration, the import, or the key, then generate again.
- For a model over its own class, declare the fields in the model.

### RUNM1059

**Generated type name clash.** Two different inline types derive the same generated name, such as `Omit<TMerchant, 'id'>` over two unrelated `TMerchant` types, or an inline type whose derived name is also the name of a model. The message lists both places. **Fix:** Declare a named type alias, for example `type TBillingMerchant = Omit<TMerchant, 'id'>`, and use it in the field.

A recursive interface, class or type alias never gives this error. It takes its declared name. A copy with the same shape, such as one `Node` declared in two files, shares one schema and the plain name.

A type of another shape gets a longer name when another type already holds the plain name. Golem takes the first free name of these:

- the type arguments of a generic instance: `Page<number>` becomes `PageNumber`, and `Page<string[]>` becomes `PageStringArray`;
- the file name: `Node` in `b.model.ts` becomes `NodeB`;
- both together: `PageNumberB`;
- a number: `NodeB2`.

The type that keeps the plain name is the one read first: the model source files in path order, then the models of a file in declaration order.

### RUNM1060

**Codec not exported by its package.** A `TSerde` or `TValidation` function, or a `TSerde` class, lives in another package, and the `exports` field in that package's `package.json` has no entry that reaches its file. The message names the function, the package and the file. **Fix:** Add an `exports` entry for that file to the package.

### RUNM1061

**Function reference through a type parameter.** A `TSerde` or `TValidation` inside a type alias receives its function through the alias's type parameter. **Fix:** Write `typeof` an exported function directly in the alias.

### RUNM1062

**Repeated tag in a generic alias.** A type alias holds more than one tag of the same kind, and one of them depends on a type parameter. **Fix:** Keep one tag of that kind in the alias, and add the other where you use the alias.

### RUNM1063

**Class cannot be imported.** A `TSerde` field holds a class that generated code cannot import and name. The message names the class and the file. Cases:

- An anonymous class.
- A class that its module doesn't export.
- A generic class with a type parameter that has no default.
- A class declared inside `declare module "name"`.

**Fix:**

- Name the class and export it from a module file.
- Or declare a non-generic subclass such as `class StringBox extends Box<string> {}` and use that.
- A class exported under another name or as the default export needs no change.

### RUNM1064

**Tag hidden behind another alias.** A type alias passes its type parameter to a tag through a second alias, such as `type Inner<N extends number> = MaxLength<N>` used in `type V<N extends number> = string & Inner<N>`. The generator can't find the tag on the instantiated type.

**Fix:** Write the tag directly in the alias that declares the type parameter.

### RUNM1065

**Codec or predicate declared in a model file.** A `TSerde` or `TValidation` function is declared in a `*.model.ts` or `*.models.ts` file. The two files import each other:

- Generated code imports the function.
- The model file imports its `*.model.generated.ts` file.

When the generated file loads first, the model class extends a base class that isn't initialized yet and start-up fails.

**Fix:**

- Move the function to its own module and export it there.
- Import it into the model file.

### RUNM1066

**Serde type argument is not a type name.** A call to `stringify`, `parse`, `validate`, `assertValue`, `toWireFormat` or `fromWireFormat` has a type argument that is not a single type name or `typeof` expression, such as `parse<TPayment | null>(text)`, `parse<Array<TPayment>>(text)` or `parse<TPayment, TMoney>(text)`. The message names the function and the position of the call, and `golem check` and every build tool report it.

**Fix:**

- Pass one model type alias, one model class, or `typeof` an exported codec.
- Declare a named model for a union or generic.

### RUNM1067

**Serde type argument has no codec.** The type argument of a serde call names something that is no model. The message shows the call, such as `parse<T> has no unique codec id`. The type argument can be:

- A type parameter.
- A type that no `IModel` or `IObject` declares.
- A name that several models share.

When the generated file of the model is missing, the message adds that file and says to wait for `golem generate` or `golem watch` to write it.

**Fix:**

- Name an exported `IModel` or `IObject` alias.
- Inside a generic function, take the codec as a parameter instead of a type parameter. Golem rewrites a call only where the model is known when it generates.

### RUNM1068

**Reserved name in a rewritten file.** A file that holds a serde call or a model class uses an identifier that starts with `__golem_`, which golem reserves for the imports it adds to that file, so a local with that name would capture the rewritten call. The message names the identifier. **Fix:** Rename the identifier.

### RUNM1069

**Class imported from two modules.** A file holds `parse` or `fromWireFormat` calls whose type arguments are type-only imports of two classes with the same exported name from different modules. golem imports each of them by name for the call, and a name has one module.

**Fix:**

- Import one of the classes as a value.
- Or give the two classes different names.

### RUNM1070

**Symbol-keyed property.** A model, a nested object of a model, or the type of a controller parameter has a property whose key is a symbol, such as `[sym]: string`. JSON cannot carry a symbol key. The message names the model or the type and the key.

**Fix:**

- Use a string key.
- Or remove the property.

### RUNM1071

**Nest parameter type has no codec.** A `@Body()` or `@Query()` parameter's type is a model (an `IModel` or `IObject` alias, or a class that extends a generated base class), but golem finds no single generated model for it.

The message shows the decorator and the type, such as `@Body() type Payment has no unique codec id; run golem generate`. Two causes are possible:

- The model is new and `golem generate` has not run since.
- Two models in different files share the name, and the type is not one of them.

**Fix:**

- Run `golem generate`.
- If the error stays, type the parameter with the exported `IModel` or `IObject` alias or the model class, imported from the file that declares it.

### RUNM1072

**Nest parameter disagrees with the generated operations.** `golem check` found a `@Body()` or `@Query()` parameter whose model its own operation does not hold in `src/generated/operation-codecs.ts`. A model that another operation holds does not count. The message shows the decorator and the type. Two cases:

- That file does not exist.
- The parameter is not part of a route that the controllers job generated. The job writes that file from the routes it reads.

**Fix:**

- Run `golem generate`.
- If the parameter belongs to a method that is not a route, add its file to the controllers job's `sources`, or give the parameter a primitive type.

### RUNM1074

**Model declared in a file that is not a model file.** A model field, or a `stringify`, `parse`, `validate`, `assertValue`, `toWireFormat` or `fromWireFormat` call, names an `IModel` or `IObject` alias that sits in a file whose name does not end in one of the `models.suffixes`.

Golem reads a model from a model file only. A shared folder or an installed package declares its models in model files too, such as `customer.model.ts` or `customer.model.d.ts` ([shared folder](/guide/shared-models)). The message names the alias as `file#export`.

**Fix:**

- Move the alias into a file whose name ends in a model suffix.

### RUNM1075

**`models.sources` entry outside the models root.** An entry of `models.sources` has a real path outside `models.root`. A link to a file outside the root counts as that file. A `models` job generates only files inside its root, so the job stops before it generates. The message names the entry and the root.

**Fix:**

- Remove the entry.
- Or move the file into the root.
- Or set `models.root` to a folder that holds the file.

### RUNM1076

**Golem ignores a file in a shared package.** A shared package declares models and holds no `golem.yaml` and no generated file. This code reports a shared model file that declares a model and has one of these:

- A `golem.yaml` in its package folder, or in a folder between the file and its package folder.
- A generated file beside it: `customer.model.generated.ts`, `.generated.js` or `.generated.d.ts`.

Golem does not read the `golem.yaml` and does not use the generated file. The app uses its own generated file in `models.output`. This is a warning: generation continues.

The message names the file, and golem writes it once for each run. When the `golem.yaml` configures another app that generates the same model file, the message tells you to move the model into a shared package that holds no `golem.yaml`.

**Fix:**

- Delete the file.
- Or move the model into a shared package.

### RUNM1077

**Models job below the root of another models job.** A `golem.yaml` with a `models` job lies below the `models.root` of another `golem.yaml`, in a folder with model files. Both jobs would write the generated files of those model files, so `golem generate` and `golem check` stop.

The message names each nested `golem.yaml`.

**Fix:**

- Remove the `models` job from the nested `golem.yaml`.
- Or move its folder out of the `models.root`.

### RUNM1078

**Two shared model files have one generated file.** Each app writes the generated file of a shared model file in `models.output`, at `<package name>/<path of the file in the package>.generated.ts`. Generation stops when two shared model files would write one file:

- They are in different folders.
- They have the same package name.
- They have the same path in the package.

The message names both model files and the path.

**Fix:**

- Rename one model file.
- Or move it into a package folder with another name.

### RUNM1079

**Serde function used as a value or as an optional call.** A `stringify`, `parse`, `validate`, `assertValue`, `toWireFormat` or `fromWireFormat` with type arguments is not the callee of a plain call. Examples:

- `const decode = parse<TPayment>`
- `texts.map(parse<TPayment>)`
- `parse?.<TPayment>(text)`

Golem rewrites a call only, so this code stays as you wrote it and throws when it runs. The message names the function, the form, and the position. `golem build`, `golem check` and every build tool report it. The [ESLint rule](/guide/build#lint) reports it too.

**Fix:**

- Call the function directly with its type arguments, such as `parse<TPayment>(text)`.
- To pass it as a value, write an arrow function: `texts.map((text) => parse<TPayment>(text))`.

### RUNM1080

**Object union with no literal tag.** A model field is a union of objects, named object types or models that golem must convert (a variant holds a `Date`, a `TSerde` value or a model). The variants have no required literal tag that picks one variant from the JSON.

Golem does not try the variants in turn, so generation stops. The message names the model file and lists the variants.

**Fix:**

- Give each variant a required field with a literal type that differs between variants, such as `kind: 'cat'` and `kind: 'dog'`.
- A tag may be a union of literals when the values do not overlap.

### RUNM1081

**Body or query parameter that is not a model.** A `@Body()` or `@Query()` parameter has a type that is no `IModel` or `IObject` and no class that extends a generated model class. The parameter can be whole or one field, such as `@Body('name')` or `@Query('page')`.

The type can be:

- A plain interface or a plain class.
- An inline object type.
- A primitive, or an array of arrays.
- A union with a member that is no model, or a union of models that share no required literal field with a value of its own.
- An array of a union of models, or a union in a one-field parameter such as `@Body('shape')`. Golem converts a union of models as a whole parameter only.

[`NestModelInterceptor`](/guide/nestjs-requests#what-happens-to-a-request) throws on such a parameter and Nest answers HTTP 500. The message shows the type and the decorator, such as `NoteInput is not a golem model, and NestModelInterceptor answers HTTP 500 for a @Body() parameter of that type`, and the position of the type.

What golem does depends on [`nonModelInputs`](/reference/config#root-keys) in `golem.yaml`:

- By default this is an error. `golem build`, `golem check`, the Vite plugin, the esbuild plugin and the Node loader stop before a request arrives.
- With `nonModelInputs: warn` it is a warning, and generation continues. `golem build` and `golem check` print it, and the message ends with `Generation continues, because golem.yaml sets nonModelInputs: warn.` The plugins and the loader print nothing.

**Fix:**

- Declare the input as an `IModel` or `IObject`, or bind one field whose type is a model, such as `@Body('address') address: Address`. For a union, give each model a required literal field such as `kind: 'circle'`, and use the union as a whole parameter.
- An app that handles these parameters with its own interceptor sets `nonModelInputs: warn`.

### RUNM1082

**Union that golem cannot convert.** A model field is a union that needs a conversion, such as a `Date` or a `TSerde` value, and the JSON value cannot tell which variant it is. Examples:

- Two scalar variants where one converts.
- A model reference that is no object.

Golem does not try the variants in turn, so generation stops. The message names the model file and lists the variants. An object union with no literal tag has its own code, [RUNM1080](#runm1080).

**Fix:**

- Give the field one variant that needs a conversion.
- Or make the variants objects with a required literal tag.
- Or declare the whole value with one `TSerde` pair.

### RUNM1083

**Generic type that expands without end.** A generic interface, class or type alias holds itself with other type arguments on each level, such as `interface Box<T> { next?: Box<Box<T>> }`. Each level is a new type, so no finite schema describes it. The message names the generic type.

- Golem stops when the 101st open instance of one generic declaration starts. This bound is golem's own.
- Arrays, tuples and library types do not count.

**Fix:**

- Pass the same type arguments back, such as `next?: Box<T>`.
- Or end the nesting with a named type.

### RUNM1084

**A controller reaches a later job's output.** A type of a controller reaches a file that a later job of the same `golem.yaml` writes, or a model file that imports one. The later jobs are the `openapi` jobs, which write the SDK directory, and the `controllers` jobs after this one, which write their document. The jobs run in the order `generators`, `controllers`, `openapi`, `models`, so the `controllers` job cannot read that file. Any reach counts: the model itself, an array or a union of it, a `Pick` of it that keeps no field of the SDK type, a model that holds it, and an SDK type that the controller imports. The message names the file.

Golem reads relative imports (`./sdk/index.js`) for this rule, and reads them the same way whether or not the SDK exists yet. A model file that imports a later output, directly or through the files it imports, is left out of the `controllers` job. Its models are generated by the `models` job after the file exists. An import by package name or by a `paths` alias stops with [RUNM1058](#runm1058) until the file exists.

**Fix:**

- Move the model out of the controllers root, so that no controller reaches it.
- Or do not import a later job's output from a model that the `controllers` job reads.

### RUNM1085

**Date or bigint combined with an object type.** A field is an intersection of a `Date` or a `bigint` with an object type or a model, such as `Date & TAddress`, `{ x: Date } & { x: TAddress }` or an optional form of these. An intersection is AND, and no value is both a `Date` and an object, so the field has no valid value. A phantom brand, such as `Date & { readonly __brand: 'Timestamp' }`, is no object. A field with a `TSerde` pair converts as one value and is not checked. The message names the field and the scalar.

**Fix:**

- Keep one of the two types.
- Or move the object into its own field.
- For a `bigint`, declare it with a `TSerde` pair and no object.

### RUNM1086

**Map or Set in a controller type.** A DTO field, a body, a parameter or a response is typed `Map`, `Set`, `ReadonlyMap` or `ReadonlySet`, and no `@ApiProperty` states its schema. JSON writes a `Map` or a `Set` as `{}`, so the type says nothing about the value a client receives. The message names the type and the field.

**Fix:**

- Use a `Record<string, V>` for a `Map` and an array for a `Set`.
- Or state the schema on the field with `@ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })`. A `type`, a `schema` or `additionalProperties` in the options counts. Golem then writes that schema and no property of the `Map`. A `Map` nested in an inline object or an array has no decorator to carry a schema, so it always stops.

## Validators (VALIDATE)

The validator compiler writes the checks that generated models and SDKs run. Its messages name the document, the schema and the JSON pointer of the keyword it rejects, such as `orders.yaml: schema "Order" at /properties/total/pattern: ...`. An error stops generation before any validator is written; a warning lets generation continue, as its entry notes.

### VALIDATE_INVALID_PATTERN

**Invalid regular expression.** A `pattern` keyword, or a key of `patternProperties`, is not a valid regular expression. golem reads each one as a JavaScript expression with the `u` flag:

- `\p{L}` is valid.
- An unterminated `[`, a lone `{` and a `\-` outside a character class are not valid.

The message shows the pattern and the reason JavaScript gives.

**Fix:** Correct the expression so that `new RegExp(pattern, 'u')` accepts it.

### VALIDATE_REF_CYCLE

**Reference cycle.** A `$ref`, or a chain of schemas that apply to the same value, leads back to itself without reading any property or item of the value, so a check could never finish.

A cycle that goes through a property or an item, such as a tree whose `children` are trees, is fine. The message points at the first `$ref` on the cycle, or at the step that closes the cycle when it has no `$ref`.

**Fix:**

- Break the cycle.
- Or make the schema read a property or an item before it refers back to itself.

### VALIDATE_UNKNOWN_FORMAT

**Format golem does not check.** A `format` keyword names a format that golem does not implement. The formats that golem checks are listed in [validation profiles](/reference/config#validation-profiles). The message names the place that declares the format, such as `schemas/money.json#/properties/amount/format`, and the generator reports it once however many operations use the schema.

- By default this is an error and generation stops.
- With `unknownFormats: warn` in [golem.yaml](/reference/config#root-keys) it is a warning. Generation continues, and values are not checked against that format.

**Fix:**

- Use an implemented format.
- Or remove the `format` keyword and state the rule with `pattern`.
- To keep the format and skip its check, set `unknownFormats: warn`.

### VALIDATE_UNKNOWN_VALIDATION

**Validation function not found.** A model uses a validation function (a `TValidation` predicate) that generation could not find. The message shows the function's identifier. **Fix:** Export that function from a source file that the generator job reads, then run `golem generate` again. The predicate must also meet the rules in [RUNM1040](#runm1040).

### VALIDATE_UNRESOLVED_REF

**Reference that does not resolve.** A `$ref` points at a schema that the document does not hold, such as `#/$defs/missing` or an identifier that no schema declares. The message shows the reference. **Fix:** Correct the pointer or the identifier, or add the schema it names.

### VALIDATE_UNSUPPORTED_KEYWORD

**Keyword golem does not support, or with an invalid value.** This code reports two cases:

- `$dynamicRef` or `$dynamicAnchor` in a schema. Dynamic references depend on the order in which a validator reaches a schema at run time, which golem's validators do not track, so ignoring them would accept data that the schema rejects.
- A keyword that golem writes into model schemas (`golemModelDate`, `golemModelInstance`, `exprtValidation`) with a value of the wrong shape. The message names the keyword and what it expects.

Annotation keywords and keywords that start with `x-` are ignored without a diagnostic.

**Fix:**

- Replace the dynamic reference with a `$ref` to a named schema.
- For a golem keyword, regenerate the schema with `golem generate` instead of editing it by hand.

## Client generator (OPENAPI)

### OPENAPI_BROWSER_COOKIE

**Browser-inaccessible cookie.** An operation has a `cookie` parameter, or uses a security scheme that's an API key sent through a cookie. Browsers don't let scripts set the `Cookie` header, so a client generated for the browser can't supply it there. This is a warning: generation continues.

**Fix:**

- Call this operation from a non-browser client.
- Or move the parameter or security scheme to a header or query location, if it must work from a browser.

### OPENAPI_COMPOSITION_CONVERSION_CONFLICT

**allOf members that convert one value in two ways.** The members of an `allOf` give one property, or the value itself, two conversions that read the same JSON type, such as `$ref` to two different models. No generated value can be both. Members that type the property as different JSON types, such as `format: date-time` and a `$ref` to a model, have no common value and follow [OPENAPI_COMPOSITION_PROPERTY_NEVER](#openapi-composition-property-never).

The message names the schema, and the property when the conflict is in one property.

**Fix:** Give that property, or the value, one schema in every member.

**A model beside a union that does not spread.** An `allOf` of a `$ref` model and a `oneOf`/`anyOf` becomes one merged object for each variant. This needs one union member whose variants are all objects. In these cases the model and the union have no merged value, and generation stops:

- The `allOf` has two union members.
- A variant is not an object.

**Fix:**

- Give the base and each variant a plain object schema.
- Put the variants in one `oneOf`/`anyOf`.

### OPENAPI_COMPOSITION_PROPERTY_NEVER

**allOf property that cannot hold a value.** An optional property of an `allOf` has no value that every member accepts. This is a warning: generation continues, and the property is typed `never`. Two causes are possible:

- A member with `additionalProperties: false` judges each name that its own `properties` do not list, also the names of its sibling members.
- Two members give the property types that have no common value, such as `format: date-time` in one member and a `$ref` to an object schema in another.

**Fix:**

- For a closed base, remove `additionalProperties: false` from the base, then add `unevaluatedProperties: false` to each component that extends it.
- For a closed member of the schema itself, replace its `additionalProperties: false` with `unevaluatedProperties: false` beside the `allOf`. The message names that member.
- For two types, give the property one type in every member.

### OPENAPI_COMPOSITION_UNSATISFIABLE

**allOf that no object satisfies.** A required property of an `allOf` cannot hold a value, for the reasons that [OPENAPI_COMPOSITION_PROPERTY_NEVER](#openapi-composition-property-never) gives, so the schema accepts no object. Generation stops. The message names each such property, its cause and the fix. **Fix:** Apply the fix of OPENAPI_COMPOSITION_PROPERTY_NEVER to each property that the message names.

**allOf members with no common type.** The members of an `allOf` declare JSON types that share no value. No value satisfies the schema, so generation stops. Examples:

- `type: string` (also `format: date-time`) beside a `$ref` to an object schema.
- `type: string` beside `type: number`.

An `integer` member and a `number` member share the integers. A member that declares no `type` makes no claim. The message names each member that declares a type.

**Fix:**

- Give the members a type that they share.
- Or remove the member that does not fit.

### OPENAPI_DISCRIMINATOR_IMPLICIT_VALUE

**Implicit discriminator value.** A discriminated-union variant has no explicit `discriminator.mapping` entry, so it's selected by its raw component name — which differs from the generated model name. This is a warning: generation continues, and decoding still works using the raw component name as the implicit value.

**Fix:** Add an explicit `mapping` entry if the JSON value should differ from the raw component name.

### OPENAPI_DISCRIMINATOR_INHERITANCE_UNSUPPORTED

**Unsupported discriminator inheritance.** A schema declares a `discriminator` without `oneOf`/`anyOf` — the pattern for selecting a subtype through `allOf` inheritance. This is a warning: generation continues, but a subtype that extends the schema through `allOf` is never selected when the base type is decoded.

**Fix:** Restructure the schema as a `oneOf`/`anyOf` with `discriminator`, if a subtype needs to be selected on decode.

### OPENAPI_DISCRIMINATOR_NOT_LOWERED

**Discriminator unusable for conversion.** A schema has a `discriminator` with `oneOf`/`anyOf`, but not every variant resolves to an exact component-schema reference — for example, an inline variant. This is a warning: generation continues, but the discriminator isn't used to pick a variant when decoding. **Fix:** Make every `oneOf`/`anyOf` variant an exact `$ref` to a component schema.

### OPENAPI_OPERATION_RENAMED

**Operation renamed.** The generated operation name is a JavaScript reserved word or an existing client member name (such as `constructor`), so the generator appends its allocator's suffix to make it distinct. This is a warning: generation continues, but the operation's exported name no longer matches its `operationId` or inferred name.

**Fix:** Give the operation an `operationId` that isn't a JavaScript reserved word or client member name, if you need the two to match exactly.

### OPENAPI_SERVER_OVERRIDE_IGNORED

**Operation servers ignored.** The document has no root `servers`, and an operation, or its path item, lists its own `servers`. A client of a document without servers requires `baseUrl`, and `baseUrl` wins over every server list, so the client uses `baseUrl` for that operation. This is a warning: generation continues.

**Fix:**

- Pass `baseUrl` to the client.
- Or list the servers at the root of the document, so that the operation list can override them.

### OPENAPI_UNION_DISCRIMINATOR_MISSING

**Object union with no literal tag.** A `oneOf`/`anyOf` of objects needs a conversion (a variant holds a `date-time` string, or a model), and no property tells the variants apart:

- The union has no `discriminator`.
- The variants have no required `const` or single-value `enum` property that differs between variants.

Generation does not try the variants in turn, so it stops. The message names the schema, where it sits in the document, and lists the variants.

**Fix:**

- Add a required `const` or `enum` property with a different value to each variant.
- Or add a `discriminator` (`propertyName` and `mapping`) to the `oneOf`/`anyOf`, and make each variant a component schema that carries that property.
