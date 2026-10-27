# Share models between apps

Declare models in one folder or package, and generate them in each app.

## What a shared model file is

A shared model file is a model file whose real path is outside `models.root`, such as a file in a folder or package that several apps include. An app includes the folder, links it or installs the package. Golem follows links to the real path of the file. A declaration file such as `customer.model.d.ts` is always a shared model file. The folder needs no `golem.yaml`, and golem writes no file in it. Each app generates the shared models in its own output.

## Include the folder

The app needs no configuration for the folder.

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

An alias in a file that does not end in a model suffix is not a model ([RUNM1074](/reference/diagnostics#runm1074)).

## Where each app writes

Each app generates the shared models in its own `models.output`, and golem writes nothing into the shared folder. The generated file is at:

```text
<models.output>/<package name>/<path of the file in the package>.generated.ts
```

The package name is the `name` in the nearest `package.json` above the file. With a `package.json` named `@acme/shared`, the file `shared/customer.model.ts` gives `src/generated/models/@acme/shared/customer.model.generated.ts` in `apps/web`.

## Extend in each app

Your code imports the generated base class from the file in its own `models.output`. The class that extends it stays in the app, and each app can add its own methods:

<<< ../../examples/shared-folder/apps/web/src/customer.ts#web-class

Each app has its own profile. The worker below uses the same shared model with `validation: false`, and loads the generated file of its own `models.output`:

<<< ../../examples/shared-folder/apps/worker/src/customers.ts#worker-use

## Functions in a shared folder

A shared folder can also hold:

- Plain types. A plain type is a field type of a model. Its constraints, such as `MinLength`, apply in the generated file of that model.
- `TSerde` and `TValidation` functions. Golem imports a function of the folder by a relative path. This holds also when a named package above the app, such as a monorepo root, holds the folder.

A `package.json` in the folder with a `name` makes the folder a package. Golem then imports its functions by that name:

- Each app must resolve the name, and an `exports` entry must reach the file of the function. Without it, generation fails with [RUNM1060](/reference/diagnostics#runm1060).
- A file in `node_modules` always imports by the package name.
- A `package.json` without a `name` has no effect on these imports.

## What a shared folder must not hold

A shared folder holds no `golem.yaml` and no generated file. Each case has a diagnostic:

- A `golem.yaml` or a generated file in a shared folder is ignored: [RUNM1076](/reference/diagnostics#runm1076).
- A `models` job below the `models.root` of another `golem.yaml` stops generation: [RUNM1077](/reference/diagnostics#runm1077).
- Two shared model files with one generated path stop generation: [RUNM1078](/reference/diagnostics#runm1078).

Full example: [`examples/shared-folder`](https://github.com/RunicCore/golem/tree/master/examples/shared-folder), with a shared folder that declares a model, one app that includes the folder and one that reaches it through a folder link.
