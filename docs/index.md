---
layout: home
hero:
  name: Golem
  text: 'Write the type once. <span class="clip">Generate the rest.</span>'
  tagline: One toolchain for a TypeScript app's API contract, end to end. Models, validation, JSON conversion, OpenAPI documents and a typed SDK come from the types you already write.
  actions:
    - theme: brand
      text: Quick start →
      link: /guide/quick-start
    - theme: alt
      text: What is Golem
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/RunicCore/golem
---

## Start from any contract, run one command

<p class="home-lede">Start from what you have: TypeScript types, an OpenAPI document or server controllers. Each generator installs on its own. All of them run through the same <code>golem</code> command and read the same <code>golem.yaml</code>.</p>

<HomeEcosystem />

## Four packages, one job each

<div class="home-grid home-grid-4">
<article class="home-card home-card-key">
<code class="home-card-name">@exprtlabs/golem</code>
<h3>Runtime, CLI and build tools</h3>
<p>Every generated model and client imports it. It holds <code>parse</code>, <code>stringify</code>, the CLI, the build tools and the optional integrations.</p>
<span class="home-card-foot">dependencies</span>
</article>
<article class="home-card">
<code class="home-card-name">@exprtlabs/golem-model</code>
<h3>You have TypeScript fields</h3>
<p>You get a generated class with validation and JSON conversion. Your class extends it and keeps its methods.</p>
<span class="home-card-foot">devDependencies</span>
</article>
<article class="home-card">
<code class="home-card-name">@exprtlabs/golem-openapi-ts</code>
<h3>You have an OpenAPI document</h3>
<p>You get typed operations and request and response models. The client checks what it sends and what it receives.</p>
<span class="home-card-foot">devDependencies; dependencies with MobX</span>
</article>
<article class="home-card">
<code class="home-card-name">@exprtlabs/golem-ts-openapi</code>
<h3>You have server controllers</h3>
<p>You get an OpenAPI document from controller routes and types. It reads NestJS 11 controllers without starting the app.</p>
<span class="home-card-foot">devDependencies; dependencies with NestJS</span>
</article>
</div>

[Which package you need](/guide/#which-package-you-need) · [Quick start](/guide/quick-start)

## What you get from one declaration

<div class="home-grid home-grid-3">
<article class="home-card">
<h3>TypeScript is the schema</h3>
<p>Tags on a field type set its validation and its JSON form. You write no decorators, no schema language and no second copy of the fields. Your code sees the plain type.</p>
<code class="home-card-proof">name: string &amp; MinLength&lt;2&gt;</code>
</article>
<article class="home-card">
<h3>Compiled validators</h3>
<p>Golem compiles validators into TypeScript files beside your code. Nothing reads decorator metadata at runtime. Validation is on by default, and a valid value takes the fast path.</p>
<code class="home-card-proof">validation: true   # default</code>
</article>
<article class="home-card">
<h3>Strict by default</h3>
<p>Golem rejects bad input and never coerces it. A model refuses unknown fields and <code>any</code>. A format that Golem cannot check stops generation.</p>
<code class="home-card-proof">LibError { causedByInput: true }</code>
</article>
<article class="home-card">
<h3>Your own JSON forms</h3>
<p>A serde tag ties a field to two functions. Your code keeps a number, a Temporal date or minor units. The JSON holds a word, an ISO string or decimal text.</p>
<code class="home-card-proof">TSerde&lt;typeof to, typeof from&gt;</code>
</article>
<article class="home-card">
<h3>Your code survives regeneration</h3>
<p>Golem owns the generated class. Your class extends it. When you add a field and generate again, only the generated file changes.</p>
<code class="home-card-proof">class Task extends TTaskBaseModel</code>
</article>
<article class="home-card">
<h3>Types end to end</h3>
<p>Server controllers produce the OpenAPI document. The client generator turns that document back into typed operations and models for the web app.</p>
<code class="home-card-proof">controllers → openapi → client</code>
</article>
<article class="home-card">
<h3>Safe with your files</h3>
<p>A job writes over a file only when it owns that file. Any other file at that path stops the run. <code>golem check</code> writes nothing and fails on stale output.</p>
<code class="home-card-proof">npx golem check</code>
</article>
<article class="home-card">
<h3>Any build tool</h3>
<p>A build tool rewrites <code>parse&lt;T&gt;()</code> and the other serde calls to generated code. Use golem build with tsc, the Vite plugin, the esbuild plugin or the Node loader.</p>
<code class="home-card-proof">npx golem build</code>
</article>
</div>

[Define models](/guide/models) · [Validation tags](/guide/tags) · [Serialization](/guide/serialization) · [Build tools](/guide/build)

## Bring the libraries you already use

<p class="home-lede">Every integration is optional. Golem works with any mix of them, or with none. Each one is a subpath of the runtime package or a job in <code>golem.yaml</code>.</p>

<div class="home-grid home-grid-3">
<article class="home-card">
<div class="home-card-head"><h3>NestJS</h3><span class="home-card-peer">^11</span></div>
<code class="home-card-path">@exprtlabs/golem-ts-openapi/nest</code>
<p>The model interceptor converts and checks <code>@Body()</code> and <code>@Query()</code> models, and answers bad input with HTTP 400 (a default; your own interceptor can answer otherwise). A docs job writes the OpenAPI document, and the <code>nest</code> extension turns on the build rewrite that the interceptor needs.</p>
</article>
<article class="home-card">
<div class="home-card-head"><h3>MobX and React</h3><span class="home-card-peer">^6.13</span></div>
<code class="home-card-path">@exprtlabs/golem-openapi-ts/mobx</code>
<p>With the <code>mobx</code> extension, validators keep observable form state, and client operations have an observable <code>loading</code>. <code>asGenObservable</code> makes generated fields observable.</p>
</article>
<article class="home-card">
<div class="home-card-head"><h3>Vite</h3><span class="home-card-peer">≥5</span></div>
<code class="home-card-path">@exprtlabs/golem/vite</code>
<p>Add <code>golem()</code> to <code>plugins</code>. The plugin rewrites serde calls in the dev server and in the build.</p>
</article>
<article class="home-card">
<div class="home-card-head"><h3>esbuild</h3><span class="home-card-peer">^0.25</span></div>
<code class="home-card-path">@exprtlabs/golem/esbuild</code>
<p>Add <code>golem()</code> to <code>plugins</code>. The plugin rewrites serde calls when esbuild bundles your app.</p>
</article>
<article class="home-card">
<div class="home-card-head"><h3>Node.js loader</h3><span class="home-card-peer">≥22.15</span></div>
<code class="home-card-path">node --import @exprtlabs/golem/register</code>
<p>Run TypeScript files directly. The loader rewrites serde calls as Node.js loads each file.</p>
</article>
<article class="home-card">
<div class="home-card-head"><h3>Your own generator</h3><span class="home-card-peer">apiVersion 1</span></div>
<code class="home-card-path">"golem": { "block": "…" }</code>
<p>A package exports <code>generate(context)</code> and returns files. Golem writes them. Your package registers its own <code>golem.yaml</code> block.</p>
</article>
</div>

[NestJS](/guide/nestjs) · [MobX and React](/guide/mobx) · [Build tools](/guide/build) · [Write a generator](/guide/generators)

## Bad data stops at three gates

<p class="home-lede">A generated client and your server share one contract. Each side checks the data that crosses to it. On any server, <code>parse&lt;T&gt;</code> and <code>validate&lt;T&gt;</code> do the server check. With NestJS, the model interceptor does it for you.</p>

<HomeGates />

## Start where you are

Install the runtime and the generator for your starting point:

::: code-group

```sh [TypeScript types]
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-model typescript@~7.1.0-beta
```

```sh [OpenAPI document]
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-openapi-ts typescript@~7.1.0-beta
```

```sh [Server controllers]
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-ts-openapi typescript@~7.1.0-beta
```

:::

Then add its job to `golem.yaml`:

::: code-group

<<< ../examples/models/golem.yaml [TypeScript types]

<<< ../examples/payments/server/golem.yaml#openapi-job [OpenAPI document]

<<< ../examples/payments/server/golem.yaml#controllers-job [Server controllers]

:::

Run `npx golem generate` for your editor, then `npx golem build` to compile. The [quick start](/guide/quick-start) takes one model from declaration to a running app.

## JSON Schema rules, written as types

<p class="home-lede">Each tag is a TypeScript type. Golem turns it into a check in the validator, a constraint in the OpenAPI document and a check in the client.</p>

<div class="home-grid home-grid-3 home-tags">
<div class="home-tagset"><b>Numbers</b><span>Integer · Minimum&lt;N&gt; · Maximum&lt;N&gt; · ExclusiveMinimum&lt;N&gt; · ExclusiveMaximum&lt;N&gt; · MultipleOf&lt;N&gt;</span></div>
<div class="home-tagset"><b>Strings</b><span>MinLength&lt;N&gt; · MaxLength&lt;N&gt; · Pattern&lt;'…'&gt; · Format&lt;'…'&gt;</span></div>
<div class="home-tagset"><b>Arrays</b><span>MinItems&lt;N&gt; · MaxItems&lt;N&gt; · UniqueItems · Contains&lt;T&gt; · MinContains&lt;N&gt; · MaxContains&lt;N&gt;</span></div>
<div class="home-tagset"><b>Objects</b><span>MinProperties&lt;N&gt; · MaxProperties&lt;N&gt; · PropertyNames&lt;T&gt; · PatternProperties&lt;Map&gt; · AdditionalProperties&lt;T&gt; · UnevaluatedProperties&lt;T&gt;</span></div>
<div class="home-tagset"><b>Related fields</b><span>DependentRequired&lt;Map&gt; · DependentSchemas&lt;Map&gt;</span></div>
<div class="home-tagset"><b>Alternatives and custom rules</b><span>OneOf&lt;Tuple&gt; · Not&lt;T&gt; · IfThenElse&lt;C, T, E&gt; · TValidation&lt;typeof rule&gt;</span></div>
</div>

[Validation tags](/guide/tags) · [Validate models](/guide/validation)

## What Golem does for each job

Golem reads the types you already write and generates each piece from them. You keep one declaration for each model.

| Job | How Golem does it |
| --- | --- |
| Classes from JSON | `parse<Task>(text)` |
| Validation | tags on the field type |
| Your own JSON forms | a serde tag on the field type |
| OpenAPI from NestJS | read from the controller's types |
| OpenAPI to TypeScript SDK | typed operations with validated models |

## What it runs on

<div class="home-grid home-versions">
<div class="home-ver"><b>≥ 22.15.0</b><span>Node.js</span></div>
<div class="home-ver"><b>6.x · 7.1+</b><span>TypeScript, same output on both</span></div>
<div class="home-ver"><b>3.1 · 3.2</b><span>OpenAPI input</span></div>
<div class="home-ver"><b>3.2.0 · 3.1.2</b><span>OpenAPI output</span></div>
<div class="home-ver"><b>all optional</b><span>NestJS ^11 · MobX ^6.13 · Vite ≥5 · esbuild ^0.25 · ESLint ^9 or ^10</span></div>
</div>

The configuration format and the public subpaths of `@exprtlabs/golem` follow semver ([Compatibility](/compatibility)).
