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

## Link the folder

An app can also reach the folder through a path inside its own folder. Link the folder with a symlink, or install it as a workspace package.

- A symlink, from the app folder: `ln -s ../../shared apps/worker/shared`. The app then lists `shared/**/*.ts` in its tsconfig `include`. Golem follows the link to the real path, so the models still count as shared model files.
- A workspace package: give the folder a `package.json` with a `name`, list it in the `workspaces` of the root `package.json`, and import it by that name in the app. The generated folder carries that name, and the functions of the folder import by it (see below).

The example commits no link, because a symlink does not survive every checkout or archive. Its `npm run link-shared` script makes the link in `apps/worker/shared` before `generate` and `test`, and `.gitignore` lists the link.

## Declare the models

Declare the `IModel` or `IObject` aliases in a model file, a file whose name ends in one of the [`models.suffixes`](/reference/config#typescript-models). The shared folder holds declarations and the functions its tags use, such as a `TSerde` function. It holds no class and no generated file.

<<< ../../examples/shared-folder/shared/customer.model.ts#shared-model

An alias in a file that does not end in a model suffix is not a model ([RUNM1074](/reference/diagnostics#runm1074)).

## Where each app writes

Each app generates the shared models in its own `models.output`, and golem writes nothing into the shared folder. The generated file is at:

```text
<models.output>/<package name>/<path of the file in the package>.generated.ts
```

The package name is the `name` in the nearest `package.json` that has one, going up from the file to the nearest folder that also holds the app. A `package.json` without a `name` only sets the module format and is passed over. When none has a `name`, the package name is the name of the first folder below that common folder: in the example, `shared`, below `examples/shared-folder`. With a `package.json` named `@acme/shared`, the file `shared/customer.model.ts` gives `src/generated/models/@acme/shared/customer.model.generated.ts` in `apps/web`. With no named `package.json`, as in the example, it gives `src/generated/models/shared/customer.model.generated.ts`.

## Extend in each app

Your code imports the generated base class from the file in its own `models.output`. The class that extends it stays in the app, and each app can add its own methods:

<<< ../../examples/shared-folder/apps/web/src/customer.ts#web-class

Each app has its own profile. The worker below uses the same shared model with `validation: false`. It imports no generated file: `golem build` adds that import for the `parse` call.

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
