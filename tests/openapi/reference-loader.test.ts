import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { loadReferenceGraph, type ReferenceGraph } from '#openapi/reference-loader';
import { createFixtureProject } from '../fixture-project.js';

function write(directory: string, name: string, value: unknown): string {
  const filename = path.join(directory, name);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
  return filename;
}

function root(extra: Record<string, unknown>): Record<string, unknown> {
  return { openapi: '3.1.0', info: { title: 'Loader', version: '1' }, ...extra };
}

function targetsOf(graph: ReferenceGraph, directory: string): string[] {
  const base = pathToFileURL(directory).href;
  return graph.sites
    .filter((site) => site.target)
    .map((site) => `${site.kind} ${site.target?.uri.replace(base, '.')}#${site.target?.pointer} preserve=${site.preserve}`)
    .sort();
}

function failingFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
  return () => { globalThis.fetch = original; };
}

test('loads local documents transitively and records every site', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-local-');
  write(directory, 'schemas/user.json', { type: 'object', properties: { address: { $ref: './address.json' } } });
  write(directory, 'schemas/address.json', { type: 'object' });
  write(directory, 'params.json', { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } });
  const document = root({
    paths: {
      '/u': {
        get: {
          parameters: [{ $ref: './params.json#/Limit' }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './schemas/user.json' } } } } },
        },
      },
    },
  });
  const filename = write(directory, 'api.json', document);
  const observed: string[] = [];
  const graph = await loadReferenceGraph(filename, document, { onInput: (file) => { observed.push(file); } });
  assert.deepEqual(targetsOf(graph, directory), [
    'parameters ./params.json#/Limit preserve=false',
    'schemas ./schemas/address.json# preserve=false',
    'schemas ./schemas/user.json# preserve=false',
  ]);
  assert.deepEqual(graph.localFiles, [
    filename,
    path.join(directory, 'params.json'),
    path.join(directory, 'schemas/address.json'),
    path.join(directory, 'schemas/user.json'),
  ].sort());
  assert.ok(observed.includes(path.join(directory, 'schemas/address.json')));
});

test('equivalent spellings of one file resolve to one target', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-spellings-');
  write(directory, 'x.json', { type: 'string' });
  const document = root({
    components: { schemas: { A: { $ref: './x.json' }, B: { $ref: './x.json#' }, C: { $ref: 'x.json' } } },
  });
  const graph = await loadReferenceGraph(write(directory, 'api.json', document), document);
  const targets = new Set(graph.sites.map((site) => `${site.target?.uri}#${site.target?.pointer}`));
  assert.equal(targets.size, 1);
  assert.equal(graph.documents.size, 2);
});

test('a missing referenced file is observed before the error', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-missing-');
  const document = root({ components: { schemas: { A: { $ref: './later.json' } } } });
  const observed: string[] = [];
  await assert.rejects(
    () => loadReferenceGraph(write(directory, 'api.json', document), document, { onInput: (file) => { observed.push(file); } }),
    /referenced document does not exist: .*later\.json/,
  );
  assert.ok(observed.includes(path.join(directory, 'later.json')));
});

test('a referenced file that fails to parse is observed and named in the error', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-parse-');
  write(directory, 'broken.yaml', 'type: [unclosed');
  const document = root({ components: { schemas: { A: { $ref: './broken.yaml' } } } });
  const observed: string[] = [];
  await assert.rejects(
    () => loadReferenceGraph(write(directory, 'api.json', document), document, { onInput: (file) => { observed.push(file); } }),
    (error: unknown) => error instanceof Error && error.message.startsWith(`${path.relative(process.cwd(), path.join(directory, 'broken.yaml'))}:1:`) && error.cause instanceof YAML.YAMLParseError,
  );
  assert.ok(observed.includes(path.join(directory, 'broken.yaml')));
});

test('refs to an absolute $id are preserved and never fetched', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-id-');
  write(directory, 'money.json', { $id: 'https://schemas.example/money', type: 'object' });
  write(directory, 'order.json', { type: 'object', properties: { total: { $ref: 'https://schemas.example/money' } } });
  const document = root({
    components: { schemas: { Money: { $ref: './money.json' }, Order: { $ref: './order.json' } } },
  });
  const restore = failingFetch();
  try {
    const graph = await loadReferenceGraph(write(directory, 'api.json', document), document);
    assert.deepEqual(targetsOf(graph, directory), [
      'schemas ./money.json# preserve=false',
      'schemas ./money.json# preserve=true',
      'schemas ./order.json# preserve=false',
    ]);
  } finally {
    restore();
  }
});

test('anchor fragments into external documents are rejected', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-anchor-');
  write(directory, 'x.json', { $defs: { a: { $anchor: 'thing', type: 'string' } } });
  const document = root({ components: { schemas: { A: { $ref: './x.json#thing' } } } });
  await assert.rejects(
    () => loadReferenceGraph(write(directory, 'api.json', document), document),
    /anchor fragments are only supported within the root document: \.\/x\.json#thing/,
  );
});

test('a remote ref inside a local file is blocked unless remote refs are allowed', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-nested-remote-');
  write(directory, 'x.json', { $ref: 'https://schemas.example/y.json' });
  const document = root({ components: { schemas: { A: { $ref: './x.json' } } } });
  const filename = write(directory, 'api.json', document);
  const restore = failingFetch();
  try {
    await assert.rejects(() => loadReferenceGraph(filename, document), /remote reference blocked at #\/\$ref: https:\/\/schemas\.example\/y\.json/);
    const skipped = await loadReferenceGraph(filename, document, { skipRemote: true });
    assert.deepEqual(skipped.localFiles, [filename, path.join(directory, 'x.json')].sort());
  } finally {
    restore();
  }
});

test('allowing remote refs without an allowed host fails before any request', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-no-hosts-');
  const document = root({ components: { schemas: { A: { $ref: 'https://schemas.example/y.json' } } } });
  const filename = write(directory, 'api.json', document);
  const restore = failingFetch();
  try {
    await assert.rejects(
      () => loadReferenceGraph(filename, document, { allowRemoteRefs: true, remoteHosts: [] }),
      /^Error: remote references require at least one explicitly allowed remote host$/,
    );
  } finally {
    restore();
  }
});

// Regression: a component declared before the `$id` owner it references by absolute URL
// (`Order` before `Money`) must not depend on walk order — the http(s) classification (identity
// check, blocked/host errors, fetch) is deferred until the local queue drains and every loaded
// document's `$id`s are registered, then retried.
test('a site declared before its absolute-$id target still resolves locally without fetching', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-id-order-');
  write(directory, 'money.json', { $id: 'https://schemas.example/money', type: 'object' });
  write(directory, 'order.json', { type: 'object', properties: { total: { $ref: 'https://schemas.example/money' } } });
  const document = root({
    components: { schemas: { Order: { $ref: './order.json' }, Money: { $ref: './money.json' } } },
  });
  const restore = failingFetch();
  try {
    const graph = await loadReferenceGraph(
      write(directory, 'api.json', document),
      document,
      { allowRemoteRefs: true, remoteHosts: ['schemas.example'] },
    );
    assert.deepEqual(targetsOf(graph, directory), [
      'schemas ./money.json# preserve=false',
      'schemas ./money.json# preserve=true',
      'schemas ./order.json# preserve=false',
    ]);
  } finally {
    restore();
  }
});

test('the same declared-before-its-$id case resolves without throwing when remote refs are disabled', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-id-order-disabled-');
  write(directory, 'money.json', { $id: 'https://schemas.example/money', type: 'object' });
  write(directory, 'order.json', { type: 'object', properties: { total: { $ref: 'https://schemas.example/money' } } });
  const document = root({
    components: { schemas: { Order: { $ref: './order.json' }, Money: { $ref: './money.json' } } },
  });
  const restore = failingFetch();
  try {
    const graph = await loadReferenceGraph(write(directory, 'api.json', document), document);
    assert.deepEqual(targetsOf(graph, directory), [
      'schemas ./money.json# preserve=false',
      'schemas ./money.json# preserve=true',
      'schemas ./order.json# preserve=false',
    ]);
  } finally {
    restore();
  }
});

// Regression: identity resolution must not depend on load order even when a reference only
// resolves to http(s) via the enclosing schema's own `$id` (`schemaBase`), not via the physical
// document URI. `order.json` declares `$id: 'https://schemas.example/order'` and its `total`
// property writes `$ref: 'money'` — resolved against `documentUri` that looks like a
// same-directory file literally named `money` (no extension, and it does not exist on disk), but
// resolved against the schema's own `$id` it is `https://schemas.example/money`, which
// `money.json` declares as its `$id`.
function writeSchemaBaseIdFixture(directory: string): void {
  write(directory, 'order.json', {
    $id: 'https://schemas.example/order',
    type: 'object',
    properties: { total: { $ref: 'money' } },
  });
  write(directory, 'money.json', { $id: 'https://schemas.example/money', type: 'object' });
}

test('an identity that only resolves via the enclosing schema\'s own $id still resolves when its target is declared after it', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-id-schemabase-order-');
  writeSchemaBaseIdFixture(directory);
  const document = root({
    components: { schemas: { Order: { $ref: './order.json' }, Money: { $ref: './money.json' } } },
  });
  const filename = write(directory, 'api.json', document);
  const observed: string[] = [];
  const graph = await loadReferenceGraph(filename, document, { onInput: (file) => { observed.push(file); } });
  assert.deepEqual(targetsOf(graph, directory), [
    'schemas ./money.json# preserve=false',
    'schemas ./money.json# preserve=true',
    'schemas ./order.json# preserve=false',
  ]);
  assert.ok(!observed.includes(path.join(directory, 'money')));
});

test('the same schemaBase-only identity resolves when its target is declared before it', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-id-schemabase-money-first-');
  writeSchemaBaseIdFixture(directory);
  const document = root({
    components: { schemas: { Money: { $ref: './money.json' }, Order: { $ref: './order.json' } } },
  });
  const filename = write(directory, 'api.json', document);
  const observed: string[] = [];
  const graph = await loadReferenceGraph(filename, document, { onInput: (file) => { observed.push(file); } });
  assert.deepEqual(targetsOf(graph, directory), [
    'schemas ./money.json# preserve=false',
    'schemas ./money.json# preserve=true',
    'schemas ./order.json# preserve=false',
  ]);
  assert.ok(!observed.includes(path.join(directory, 'money')));
});

test('a fetched remote document cannot reference a local file', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-remote-file-');
  const document = root({ components: { schemas: { A: { $ref: 'https://schemas.example/remote.json' } } } });
  const filename = write(directory, 'api.json', document);
  const secret = write(directory, 'secret.json', { type: 'string' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ $ref: `file://${secret}` }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  const observed: string[] = [];
  try {
    await assert.rejects(
      () => loadReferenceGraph(filename, document, {
        allowRemoteRefs: true,
        remoteHosts: ['schemas.example'],
        onInput: (file) => { observed.push(file); },
      }),
      /remote document cannot reference local file: .*secret\.json/,
    );
    assert.ok(!observed.includes(secret));
  } finally {
    globalThis.fetch = original;
  }
});

test('a missing reference under a symlinked root directory is watched, not reported as an escape', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-symlink-root-');
  const real = path.join(directory, 'real');
  mkdirSync(real);
  const linked = path.join(directory, 'linked');
  symlinkSync(real, linked, 'dir');
  const document = root({ components: { schemas: { A: { $ref: './later.json' } } } });
  const filename = write(linked, 'api.json', document);
  const observed: string[] = [];
  await assert.rejects(
    () => loadReferenceGraph(filename, document, { onInput: (file) => { observed.push(file); } }),
    /referenced document does not exist: .*later\.json/,
  );
  assert.ok(observed.includes(path.join(linked, 'later.json')));
});

// Regression: a folder whose name starts with `..` lies inside the input directory; only a real
// parent step (`../`) leaves it.
test('a local ref into a folder named ..shared loads, while ../outside.yaml is still an escape', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-dotdot-folder-');
  const input = path.join(directory, 'input');
  write(input, '..shared/pet.yaml', { Pet: { type: 'object' } });
  write(directory, 'outside.yaml', { type: 'string' });
  const inside = root({ components: { schemas: { Pet: { $ref: './..shared/pet.yaml#/Pet' } } } });
  const graph = await loadReferenceGraph(write(input, 'api.json', inside), inside);
  assert.deepEqual(targetsOf(graph, input), ['schemas ./..shared/pet.yaml#/Pet preserve=false']);
  const outside = root({ components: { schemas: { Escaped: { $ref: '../outside.yaml' } } } });
  await assert.rejects(
    () => loadReferenceGraph(write(input, 'escape.json', outside), outside),
    /local reference escapes the input directory/,
  );
});

// Regression: a ref to an absolute non-http `$id` (`urn:`) must not depend on load order. Every
// absolute non-`file:` reference waits, like http(s), until every local `$id` is registered.
for (const order of [['Order', 'Money'], ['Money', 'Order']] as const) {
  test(`a urn: $id reference resolves when components are declared ${order.join(' before ')}`, async (t) => {
    const directory = createFixtureProject(t, 'golem-loader-urn-order-');
    write(directory, 'money.json', { $id: 'urn:example:money', type: 'object' });
    write(directory, 'order.json', { type: 'object', properties: { total: { $ref: 'urn:example:money' } } });
    const files = { Order: { $ref: './order.json' }, Money: { $ref: './money.json' } };
    const document = root({ components: { schemas: Object.fromEntries(order.map((name) => [name, files[name]])) } });
    const restore = failingFetch();
    try {
      const graph = await loadReferenceGraph(write(directory, 'api.json', document), document);
      assert.deepEqual(targetsOf(graph, directory), [
        'schemas ./money.json# preserve=false',
        'schemas ./money.json# preserve=true',
        'schemas ./order.json# preserve=false',
      ]);
    } finally {
      restore();
    }
  });
}

test('a root ref to a urn: $id declared in another file resolves to that file', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-urn-root-');
  write(directory, 'money.json', { $id: 'urn:example:money', type: 'object' });
  const document = root({
    components: { schemas: { Price: { type: 'object', properties: { amount: { $ref: 'urn:example:money' } } }, Money: { $ref: './money.json' } } },
  });
  const graph = await loadReferenceGraph(write(directory, 'api.json', document), document);
  assert.deepEqual(targetsOf(graph, directory), [
    'schemas ./money.json# preserve=false',
    'schemas ./money.json# preserve=true',
  ]);
});

test('a urn: reference that no $id declares fails with an unsupported scheme', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-urn-missing-');
  const document = root({ components: { schemas: { Price: { $ref: 'urn:example:nothing' } } } });
  await assert.rejects(
    () => loadReferenceGraph(write(directory, 'api.json', document), document),
    /^Error: unsupported reference scheme urn: in urn:example:nothing$/,
  );
});

// Regression: a fetched remote document declaring a `file:` `$id` must not shadow the local file
// with that URL. `wrapper.json`'s `$id` defers its `inner.json` ref until after the remote
// document loads, so `inner.json`'s `./money.json` ref is classified with the remote `$id`s
// already registered.
test('a remote document cannot shadow a local file with a file: $id', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-remote-file-id-');
  write(directory, 'wrapper.json', { $id: 'https://schemas.example/wrapper', type: 'object', properties: { inner: { $ref: 'inner.json' } } });
  write(directory, 'inner.json', { type: 'object', properties: { money: { $ref: './money.json' } } });
  write(directory, 'money.json', { type: 'integer' });
  const document = root({
    components: { schemas: { A: { $ref: 'https://schemas.example/remote.json' }, B: { $ref: './wrapper.json' } } },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ $id: pathToFileURL(path.join(directory, 'money.json')).href, type: 'string' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    const graph = await loadReferenceGraph(write(directory, 'api.json', document), document, {
      allowRemoteRefs: true,
      remoteHosts: ['schemas.example'],
    });
    assert.deepEqual(targetsOf(graph, directory), [
      'schemas ./inner.json# preserve=false',
      'schemas ./money.json# preserve=false',
      'schemas ./wrapper.json# preserve=false',
      'schemas https://schemas.example/remote.json# preserve=false',
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('discriminator mapping values are sites addressed by their mapping key; component names and $id identities stay as written', async (t) => {
  const directory = createFixtureProject(t, 'golem-loader-mapping-');
  write(directory, 'dog.json', { $id: 'https://schemas.example/dog', type: 'object' });
  write(directory, 'cat.json', { type: 'object' });
  const document = root({
    components: {
      schemas: {
        'bird.json': { type: 'object' },
        Pet: {
          oneOf: [{ $ref: './dog.json' }],
          discriminator: {
            propertyName: 'kind',
            mapping: { 'a/b': './cat.json', dog: 'https://schemas.example/dog', bird: 'bird.json', fish: 'Fish', self: '#/components/schemas/Pet' },
          },
        },
      },
    },
  });
  const restore = failingFetch();
  try {
    const graph = await loadReferenceGraph(write(directory, 'api.json', document), document);
    const mappingSites = graph.sites
      .filter((site) => site.keyword === 'mapping')
      .map((site) => `${site.ownerPointer} ${site.property} ${site.reference} target=${site.target ? 'yes' : 'no'} preserve=${site.preserve}`)
      .sort();
    assert.deepEqual(mappingSites, [
      '/components/schemas/Pet/discriminator/mapping a/b ./cat.json target=yes preserve=false',
      '/components/schemas/Pet/discriminator/mapping dog https://schemas.example/dog target=yes preserve=true',
      '/components/schemas/Pet/discriminator/mapping self #/components/schemas/Pet target=yes preserve=false',
    ]);
    assert.ok(graph.localFiles.includes(path.join(directory, 'cat.json')));
  } finally {
    restore();
  }
});
