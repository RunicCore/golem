# Diagnostics

Find what a generator error code means and how to fix it.

An error prints its code, location when known, and message, then stops generation; a warning prints the same and lets generation continue, as its entry below notes. The printed line may also carry a severity word next to the code.

## Controller generator (NEST)

### NEST1001

**No exported controllers.** No exported class decorated with `@Controller` exists among the configured source files. **Fix:** Export at least one `@Controller` class, or list the files that declare it in `sources` of the controller job.

### NEST1002

**No controller sources.** No file that ends in one of the controller `suffixes` (default `.controller.ts`) exists under `src` of the job `root`, and the controller job has no `sources`. **Fix:** Add a controller file, or list the controller files in `sources` of the controller job.

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

### NEST1401

**Invalid info.** `info` of the controller job, or its `title` or `version` field, is missing, not an object, or not a non-empty string. **Fix:** Set `info` with a `title` and a `version` that are non-empty strings.

### NEST1402

**Unsupported OpenAPI version.** `openapiVersion` of the controller job names something other than `'3.2.0'` or `'3.1.2'`. **Fix:** Set `openapiVersion` to `'3.2.0'` or `'3.1.2'`, or omit it to use the default.

### NEST1403

**Invalid server.** A `servers` entry of the controller job doesn't match the OpenAPI Server Object shape — a non-object entry, an unsupported property, a missing or empty `url`, or a `variables` entry whose `default` isn't a string included in its `enum`. **Fix:** Shape each server as `{ url, description?, variables? }`, and make sure a variable's `default` is one of its `enum` values.

### NEST1404

**Invalid security scheme.** A security scheme in `securitySchemes` of the controller job doesn't match its type's OpenAPI shape — an unsupported `type`, an unsupported property for that type, or an OAuth2 flow missing a required URL or `scopes`. **Fix:** Match the OpenAPI Security Scheme Object for the chosen `type` (`apiKey`, `http`, `mutualTLS`, `oauth2`, or `openIdConnect`).

### NEST1405

**Invalid security requirement.** A route's security requirement names a scheme that isn't in `securitySchemes` of the controller job, its scopes aren't an array of strings, or `@ApiSecurity()` doesn't resolve to a scheme name or a record of scheme scopes. **Fix:** Add the scheme to `securitySchemes`, or fix the `@ApiSecurity()` or security requirement shape.

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

## Route evaluation (RUNT)

### RUNT2101

**Unsupported route expression.** A route path or version in a controller decorator is neither a string literal nor a simple route helper that golem can fold at generation time. **Fix:** Write the path as a string literal, an array of string literals, or a helper that returns one value, as in [route helpers](/reference/nestjs#route-helpers).

### RUNT2106

**Route result too large.** A route path or version folds to a value larger than 1 MiB when written as JSON. **Fix:** Use a shorter path or version value.

## Model generator (RUNM)

### RUNM1001

**Missing fields type.** `IModel` has no type argument for its fields. **Fix:** Give it one, such as `IModel<{ name: string }>`.

### RUNM1002

**Unexported model alias.** An `IModel` or `IObject` type alias isn't exported. **Fix:** Export the type alias.

### RUNM1003

**Unsupported TypeScript type.** A model or field type isn't one of the shapes this generator can convert — none of the recognized primitive, literal, array, tuple, object, or union forms. The message names the type and the field. **Fix:** Replace it with a supported shape, such as a plain object, array, primitive, or named model reference.

### RUNM1004

**Callable or constructible type.** A model, or one of its fields, resolves to a type with call or construct signatures — a function or a class-instance shape rather than plain data. **Fix:** Replace it with a plain object, array, or primitive.

### RUNM1005

**Duplicate generated model name.** Two `IModel`/`IObject` declarations in the same model source produce the same generated name. **Fix:** Rename one of the declarations.

### RUNM1011

**Field contains any or unknown.** A field's type includes `any` or `unknown`, and the model doesn't allow it. The check includes the parameter of a `TSerde` deserializer. **Fix:** Replace it with a concrete type, or allow it with `{ allowAny: true }` as `IModel`'s second type argument, or `allowAny: true` in `golem.yaml`.

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

**Unresolvable recursive type.** A type refers back to itself, and golem cannot give the cycle a name. A recursive type alias gets its name from the alias, so the cycle needs a type alias that you wrote. **Fix:** Declare the recursive shape as a named type alias, for example `type Tree = { children: Tree[] }`, or as a named model.

### RUNM1057

**Generic IModel declaration.** An `IModel`/`IObject` type alias declares its own type parameters. **Fix:** Put generic wrappers outside `IModel`, and instantiate them in a concrete, non-generic model declaration.

### RUNM1058

**Unresolved contract type.** A field has TypeScript's internal error type, because golem could not resolve a declaration or an import. Golem also reports this code when a `Pick` names a member that its source type does not declare. Golem also reports this code when a model is defined by a mapped type over its own class, such as `IModel<{ [K in keyof Customer]: Customer[K] }>` where `Customer` extends the generated base of that model: the base is generated from the model, so the type has no members. **Fix:** Fix the declaration, the import, or the key, then generate again. For a model over its own class, declare the fields in the model.

### RUNM1059

**Generated type name clash.** Two different inline types derive the same generated name, such as `Omit<TMerchant, 'id'>` over two unrelated `TMerchant` types, or an inline type whose derived name is also the name of a model. The message lists both places. **Fix:** Declare a named type alias for one of the inline types, for example `type TBillingMerchant = Omit<TMerchant, 'id'>`, and use it in the field.

### RUNM1060

**Codec not exported by its package.** A `TSerde` or `TValidation` function, or a `TSerde` class, lives in another package, and the `exports` field in that package's `package.json` has no entry that reaches its file. The message names the function, the package and the file. **Fix:** Add an `exports` entry for that file to the package.

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

### RUNM1071

**Nest parameter type has no codec.** A `@Body()` or `@Query()` parameter's type is a model (an `IModel` or `IObject` alias, or a class that extends a generated base class), but golem finds no single generated model for it. Either the model is new and `golem generate` has not run since, or two models in different files share the name and the type is not one of them. The message shows the decorator and the type, such as `@Body() type Payment has no unique codec id; run golem generate`. **Fix:** Run `golem generate`. If the error stays, type the parameter with the exported `IModel` or `IObject` alias or the model class, imported from the file that declares it.

### RUNM1072

**Nest parameter disagrees with the generated operations.** `golem check` found a `@Body()` or `@Query()` parameter whose model is missing from `src/generated/operation-codecs.ts`, or that file does not exist. The controllers job writes that file from the routes it reads, so the parameter is not part of a route it generated. The message shows the decorator and the type. **Fix:** Run `golem generate`. If the parameter belongs to a method that is not a route, add its file to the controllers job's `sources`, or give the parameter a primitive type.

### RUNM1073

**Job reads the tsconfig above its root.** A `models` or `controllers` job's `root` has no `tsconfig.json` and `golem.yaml` sets no `tsconfig`, so the job reads the nearest `tsconfig.json` above its root, as `tsc` does: that file's `paths` and compiler options apply to the job. When that file is a solution tsconfig, the options of the referenced project that holds the job's sources apply, and the message names the solution file. This is a warning: generation continues. The job prints it when it runs, before it generates, so a failure that follows still names the file; a job skipped as unchanged prints nothing. The message names the job and the file. **Fix:** Add a `tsconfig.json` to the job's root to give it its own options, or set `tsconfig` in `golem.yaml` to the file the message names to state that the job is meant to use it.

### RUNM1074

**Model declared in a file that is not a model file.** A model field, or a `stringify`, `parse`, `validate`, `assertValue`, `toWireFormat` or `fromWireFormat` call, names an `IModel` or `IObject` alias that sits in a file whose name does not end in one of the `models.suffixes`. Golem reads a model from a model file only. A shared folder or an installed package declares its models in model files too, such as `customer.model.ts` or `customer.model.d.ts` ([shared folder](/guide/shared-models)). The message names the alias as `file#export`. **Fix:** Move the alias into a file whose name ends in a model suffix.

### RUNM1075

**`models.sources` entry outside the models root.** An entry of `models.sources` has a real path outside `models.root`. A link to a file outside the root counts as that file. A `models` job generates only files inside its root, so the job stops before it generates. The message names the entry and the root. **Fix:** Remove the entry, move the file into the root, or set `models.root` to a folder that holds the file.

### RUNM1076

**Golem ignores a file in a shared package.** A shared model file that declares a model has a `golem.yaml` in its package folder or in a folder between the file and its package folder, or a generated file beside it: `customer.model.generated.ts`, `.generated.js` or `.generated.d.ts`. A shared package declares models and holds no `golem.yaml` and no generated file. Golem does not read the `golem.yaml` and does not use the generated file. The app uses its own generated file in `models.output`. This is a warning: generation continues. The message names the file, and golem writes it once for each run. When the `golem.yaml` configures another app that generates the same model file, the message tells you to move the model into a shared package that holds no `golem.yaml`. **Fix:** Delete the file, or move the model into a shared package.

### RUNM1077

**Models job below the root of another models job.** A `golem.yaml` with a `models` job lies below the `models.root` of another `golem.yaml`, in a folder with model files. Both jobs would write the generated files of those model files, so `golem generate` and `golem check` stop. The message names each nested `golem.yaml`. **Fix:** Remove the `models` job from the nested `golem.yaml`, or move its folder out of the `models.root`.

### RUNM1078

**Two shared model files have one generated file.** Each app writes the generated file of a shared model file in `models.output`, at `<package name>/<path of the file in the package>.generated.ts`. Two shared model files in different folders that have the same package name and the same path in the package would write one file, so generation stops. The message names both model files and the path. **Fix:** Rename one model file, or move it into a package folder with another name.

### RUNM1079

**Serde function used as a value or as an optional call.** A `stringify`, `parse`, `validate`, `assertValue`, `toWireFormat` or `fromWireFormat` with type arguments is not the callee of a plain call. Examples are `const decode = parse<TPayment>`, `texts.map(parse<TPayment>)` and `parse?.<TPayment>(text)`. Golem rewrites a call only, so this code stays as you wrote it and throws when it runs. The message names the function, the form, and the position. `golem build`, `golem check` and every host report it. **Fix:** Call the function directly with its type arguments, such as `parse<TPayment>(text)`. To pass it as a value, write an arrow function: `texts.map((text) => parse<TPayment>(text))`.

### RUNM1080

**Object union with no literal tag.** A model field is a union of objects, named object types or models that golem must convert (a variant holds a `Date`, a `TSerde` value or a model), and the variants have no required literal tag that picks one variant from the JSON. Golem does not try the variants in turn, so generation stops. The message names the model file and lists the variants. **Fix:** Give each variant a required field with a literal type that differs between variants, such as `kind: 'cat'` and `kind: 'dog'`. A tag may be a union of literals when the values do not overlap.

### RUNM1081

**Body or query parameter that is not a model.** A `@Body()` or `@Query()` parameter, whole or one field such as `@Body('name')` or `@Query('page')`, has a type that is no `IModel` or `IObject` and no class that extends a generated model class: a plain interface, a plain class, an inline object type, a primitive, a union, or an array of arrays. [`NestModelInterceptor`](/guide/nestjs-requests#what-happens-to-a-request) throws on such a parameter and Nest answers HTTP 500. By default this is an error, and `golem build`, `golem check`, the Vite plugin, the esbuild plugin and the Node loader stop before a request arrives. With `nonModelInputs: warn` in [golem.yaml](/reference/config#root-keys) it is a warning: generation continues. `golem build` and `golem check` print the warning, and the message ends with `Generation continues, because golem.yaml sets nonModelInputs: warn.` The plugins and the loader continue and print nothing. The message shows the type and the decorator, such as `NoteInput is not a golem model, and NestModelInterceptor answers HTTP 500 for a @Body() parameter of that type`, and the position of the type. **Fix:** Declare the input as an `IModel` or `IObject`, or bind one field whose type is a model, such as `@Body('address') address: Address`. An app that handles these parameters with its own interceptor sets `nonModelInputs: warn`.

### RUNM1082

**Union that golem cannot convert.** A model field is a union that needs a conversion, such as a `Date` or a `TSerde` value, and the JSON value cannot tell which variant it is: for example two scalar variants where one converts, or a model reference that is no object. Golem does not try the variants in turn, so generation stops. The message names the model file and lists the variants. An object union with no literal tag has its own code, [RUNM1080](#runm1080). **Fix:** Give the field one variant that needs a conversion, make the variants objects with a required literal tag, or declare the whole value with one `TSerde` pair.

## Validators (VALIDATE)

The validator compiler writes the checks that generated models and SDKs run. Its messages name the document, the schema and the JSON pointer of the keyword it rejects, such as `orders.yaml: schema "Order" at /properties/total/pattern: ...`. An error stops generation before any validator is written; a warning lets generation continue, as its entry notes.

### VALIDATE_INVALID_PATTERN

**Invalid regular expression.** A `pattern` keyword, or a key of `patternProperties`, is not a valid regular expression. golem reads each one as a JavaScript expression with the `u` flag, so `\p{L}` is valid, but an unterminated `[`, a lone `{` or a `\-` outside a character class is not. The message shows the pattern and the reason JavaScript gives. **Fix:** Correct the expression so that `new RegExp(pattern, 'u')` accepts it.

### VALIDATE_REF_CYCLE

**Reference cycle.** A `$ref`, or a chain of schemas that apply to the same value, leads back to itself without reading any property or item of the value, so a check could never finish. A cycle that goes through a property or an item, such as a tree whose `children` are trees, is fine. The message points at the first `$ref` on the cycle, or at the step that closes the cycle when it has no `$ref`. **Fix:** Break the cycle, or make the schema read a property or an item before it refers back to itself.

### VALIDATE_UNKNOWN_FORMAT

**Format golem does not check.** A `format` keyword names a format that golem does not implement. The formats that golem checks are listed in [validation profiles](/reference/config#validation-profiles). By default this is an error and generation stops. With `unknownFormats: warn` in [golem.yaml](/reference/config#root-keys) it is a warning: generation continues and values are not checked against that format. The message names the place that declares the format, such as `schemas/money.json#/properties/amount/format`, and the generator reports it once however many operations use the schema. **Fix:** Use an implemented format, or remove the `format` keyword and state the rule with `pattern`. To keep the format and skip its check, set `unknownFormats: warn`.

### VALIDATE_UNKNOWN_VALIDATION

**Validation function not found.** A model uses a validation function (a `TValidation` predicate) that generation could not find. The message shows the function's identifier. **Fix:** Export that function from a source file that the generator job reads, then run `golem generate` again. The predicate must also meet the rules in [RUNM1040](#runm1040).

### VALIDATE_UNRESOLVED_REF

**Reference that does not resolve.** A `$ref` points at a schema that the document does not hold, such as `#/$defs/missing` or an identifier that no schema declares. The message shows the reference. **Fix:** Correct the pointer or the identifier, or add the schema it names.

### VALIDATE_UNSUPPORTED_KEYWORD

**Keyword golem does not support, or with an invalid value.** A schema uses `$dynamicRef` or `$dynamicAnchor`. Dynamic references depend on the order in which a validator reaches a schema at run time, which golem's validators do not track, so ignoring them would accept data that the schema rejects. The same code reports a keyword that golem writes into model schemas (`golemModelDate`, `golemModelInstance`, `exprtValidation`) when its value has the wrong shape; the message names the keyword and what it expects. Annotation keywords and keywords that start with `x-` are ignored without a diagnostic. **Fix:** Replace the dynamic reference with a `$ref` to a named schema. For a golem keyword, regenerate the schema with `golem generate` instead of editing it by hand.

## Client generator (OPENAPI)

### OPENAPI_BROWSER_COOKIE

**Browser-inaccessible cookie.** An operation has a `cookie` parameter, or uses a security scheme that's an API key sent through a cookie; browsers don't let scripts set the `Cookie` header, so a client generated for the browser can't supply it there. This is a warning: generation continues. **Fix:** Call this operation from a non-browser client, or move the parameter or security scheme to a header or query location if it must work from a browser.

### OPENAPI_COMPOSITION_CONVERSION_CONFLICT

**allOf members that convert one value in two ways.** The members of an `allOf` give one property, or the value itself, two conversions, such as `format: date-time` (a `Date`) and a `$ref` to a model. No generated value can be both. The message names the schema, and the property when the conflict is in one property. **Fix:** Give that property, or the value, one schema in every member.

**A model beside a union that does not spread.** An `allOf` of a `$ref` model and a `oneOf`/`anyOf` becomes one merged object for each variant. This needs one union member whose variants are all objects. When the `allOf` has two union members, or a variant that is not an object, the model and the union have no merged value. Generation stops. **Fix:** Give the base and each variant a plain object schema, and put the variants in one `oneOf`/`anyOf`.

### OPENAPI_COMPOSITION_PROPERTY_NEVER

**allOf property that cannot hold a value.** An optional property of an `allOf` has no value that every member accepts. A member with `additionalProperties: false` judges each name that its own `properties` do not list, also the names of its sibling members. Two members can also give the property types that have no common value. This is a warning: generation continues, and the property is typed `never`. **Fix:** For a closed base, remove `additionalProperties: false` from the base, then add `unevaluatedProperties: false` to each component that extends it. For a closed member of the schema itself, replace its `additionalProperties: false` with `unevaluatedProperties: false` beside the `allOf`. The message names that member. For two types, give the property one type in every member.

### OPENAPI_COMPOSITION_UNSATISFIABLE

**allOf that no object satisfies.** A required property of an `allOf` cannot hold a value, for the reasons that [OPENAPI_COMPOSITION_PROPERTY_NEVER](#openapi-composition-property-never) gives, so the schema accepts no object. Generation stops. The message names each such property, its cause and the fix. **Fix:** Apply the fix of OPENAPI_COMPOSITION_PROPERTY_NEVER to each property that the message names.

**allOf members with no common type.** The members of an `allOf` declare JSON types that share no value, such as `type: string` (also `format: date-time`) beside a `$ref` to an object schema, or `type: string` beside `type: number`. An `integer` member and a `number` member share the integers. No value satisfies the schema. Generation stops. A member that declares no `type` makes no claim. The message names each member that declares a type. **Fix:** Give the members a type that they share, or remove the member that does not fit.

### OPENAPI_DISCRIMINATOR_IMPLICIT_VALUE

**Implicit discriminator value.** A discriminated-union variant has no explicit `discriminator.mapping` entry, so it's selected by its raw component name — which differs from the generated model name. This is a warning: generation continues, and decoding still works using the raw component name as the implicit value. **Fix:** Add an explicit `mapping` entry if the wire value should differ from the raw component name.

### OPENAPI_DISCRIMINATOR_INHERITANCE_UNSUPPORTED

**Unsupported discriminator inheritance.** A schema declares a `discriminator` without `oneOf`/`anyOf` — the pattern for selecting a subtype through `allOf` inheritance. This is a warning: generation continues, but a subtype that extends the schema through `allOf` is never selected when the base type is decoded. **Fix:** Restructure the schema as a `oneOf`/`anyOf` with `discriminator`, if a subtype needs to be selected on decode.

### OPENAPI_DISCRIMINATOR_NOT_LOWERED

**Discriminator unusable for conversion.** A schema has a `discriminator` with `oneOf`/`anyOf`, but not every variant resolves to an exact component-schema reference — for example, an inline variant. This is a warning: generation continues, but the discriminator isn't used to pick a variant when decoding. **Fix:** Make every `oneOf`/`anyOf` variant an exact `$ref` to a component schema.

### OPENAPI_OPERATION_RENAMED

**Operation renamed.** The generated operation name is a JavaScript reserved word or an existing client member name (such as `constructor`), so the generator appends its allocator's suffix to make it distinct. This is a warning: generation continues, but the operation's exported name no longer matches its `operationId` or inferred name. **Fix:** Give the operation an `operationId` that isn't a JavaScript reserved word or client member name, if you need the two to match exactly.

### OPENAPI_UNION_DISCRIMINATOR_MISSING

**Object union with no literal tag.** A `oneOf`/`anyOf` of objects needs a conversion (a variant holds a `date-time` string, or a model), and no property tells the variants apart: the union has no `discriminator`, and the variants have no required `const` or single-value `enum` property that differs between variants. Generation does not try the variants in turn, so it stops. The message names the schema, where it sits in the document, and lists the variants. **Fix:** Add a required `const` or `enum` property with a different value to each variant, or add a `discriminator` (`propertyName` and `mapping`) to the `oneOf`/`anyOf` and make each variant a component schema that carries that property.

### OPENAPI_UNION_SHARED_VARIANT

**Shared union variant.** A `oneOf`/`anyOf` variant schema is also claimed by another union, so no single class can represent it as a subtype of both; the generator emits no union model class for this schema. This is a warning: generation continues, and values still decode to their variant model classes — they don't gain the shared union's own class. **Fix:** Give the variant to a single union in the OpenAPI document if it needs a dedicated union class.
