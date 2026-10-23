# Share models between apps

Declare models in one folder or package, and generate them in each app.

## Include the folder

Several apps can include one folder of types, link it, or install it from `node_modules`. The folder needs no `golem.yaml`, and the app needs no configuration for it.

Each app includes the folder in its own tsconfig, with a `rootDir` that contains both:

```json
{
  "compilerOptions": { "rootDir": "..", "outDir": "build" },
  "include": ["src/**/*.ts", "../shared/**/*.ts"]
}
```

## Declare the models

Declare the `IModel` or `IObject` aliases in a model file, a file whose name ends in one of the [`models.suffixes`](/reference/config#typescript-models). The shared folder holds declarations and the functions its tags use, such as a `TSerde` function. It holds no class and no generated file.

<<< ../../examples/shared-folder/shared/customer.model.ts#shared-model

An alias in a file that does not end in a model suffix is not a model. A field type or a serde call that uses it stops with [RUNM1074](/reference/diagnostics#runm1074). Move the alias into a model file.

## Where each app writes

A model file whose real path is inside `models.root` is a model file of the app, and its generated file stays beside it. Golem follows folder links to find the real path. Every other model file is a shared model file. It does not matter whether the app reaches it by a plain include, a folder link, a linked workspace package or `node_modules`. Its aliases are models of the app. A declaration file such as `customer.model.d.ts` is always a shared model file, also inside `models.root`, because it cannot hold your class. An SDK file is the exception to these rules. A model file that the `model-manifest.json` of an [SDK](/guide/models-and-client) lists keeps the generated code of the SDK.

Each app generates the shared models in its own `models.output`, so several apps never write to one file. Golem writes nothing into the shared folder. The generated file is at:

```text
<models.output>/<package name>/<path of the file in the package>.generated.ts
```

The package is the nearest folder above the file whose `package.json` has a `name`, and the package name is that `name`. When no such folder exists, the package is the top folder below the folder that holds both the file and your `golem.yaml`. The package name is the folder name. With a `package.json` named `@acme/shared`, the file `shared/customer.model.ts` gives `src/generated/models/@acme/shared/customer.model.generated.ts` in `apps/web`. For a declaration file, the generated name drops `.d`.

A package name that is absolute or has a `..` segment stops generation, because the name is a folder of `models.output`. Two shared model files that get one path stop generation with [RUNM1078](/reference/diagnostics#runm1078).

## Extend in each app

Your code imports the generated base class from the file in its own `models.output`. The class that extends it stays in the app, and each app can add its own methods:

<<< ../../examples/shared-folder/apps/web/src/customer.ts#web-class

Each app has its own profile. The worker below uses the same shared model with `validation: false`, and loads the generated file of its own `models.output`:

<<< ../../examples/shared-folder/apps/worker/src/customers.ts#worker-use

## Functions in a shared folder

A shared folder can also hold:

- Plain types. A plain type is a field type of a model. Its constraints, such as `MinLength`, apply in the generated file of that model.
- `TSerde` and `TValidation` functions. Golem imports a function of the folder by a relative path. This holds also when a named package above the app, such as a monorepo root, holds the folder.

A `package.json` in the folder with a `name` makes the folder a package. Golem then imports its functions by that name. Each app must resolve the name, and an `exports` entry must reach the file of the function. Without it, generation fails with [RUNM1060](/reference/diagnostics#runm1060). A file in `node_modules` always imports by the package name. A `package.json` without a `name` has no effect on these imports.

## What a shared folder must not hold

A shared folder holds no `golem.yaml` and no generated file. When one is there, golem writes the warning [RUNM1076](/reference/diagnostics#runm1076), ignores the file and continues:

- A `golem.yaml` in the folder of a shared model file, or in a folder between the file and its package folder. Golem does not read it.
- A generated file beside a shared model file, such as `customer.model.generated.ts`, `.generated.js` or `.generated.d.ts`. Golem does not use it. The app uses its own generated file.

A `golem.yaml` with a `models` job below the `models.root` of another `golem.yaml` stops `golem generate` and `golem check` with [RUNM1077](/reference/diagnostics#runm1077). Both jobs would write the same generated files. Remove the `models` job from the nested `golem.yaml`, or move its folder out of the root.

`golem generate`, `golem check`, `golem build` and `golem watch` write each warning once for each run.

Full example: [`examples/shared-folder`](https://github.com/RunicCore/golem/tree/master/examples/shared-folder), with a shared folder that declares a model, one app that includes the folder and one that reaches it through a folder link.
