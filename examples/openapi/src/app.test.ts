import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listTasks, logTaskTitles } from './list-tasks.js';
import { TasksClient, TaskModel } from '../sdk/index.js';
import { createTask, readTaskPage } from './task-requests.js';
import { createTasksClient } from './create-client.js';
import { readTask } from './read-task.js';
import { createTaskWithTitle } from './invalid-task.js';
import { readTwoTasks } from './reuse-request.js';
import { createClientWithLocale } from './shared-headers.js';
import { listWithCancelButton } from './cancel-request.js';
import { fetchTask } from './handle-errors.js';
import { loadTask } from './task-model.js';
import { readTaskDirectly } from './standalone-operation.js';

test('listTasks builds a client from a base URL and executes the list operation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = new Request(input);
    assert.equal(request.url, 'https://example.test/tasks');
    return Response.json([{ id: 'task-1', title: 'Write release notes' }]);
  }) as typeof fetch;
  try {
    const response = await listTasks('https://example.test');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ id: 'task-1', title: 'Write release notes' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('logTaskTitles reads each task title from the response body', async () => {
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => Response.json([{ id: 'task-1', title: 'Review' }]),
  });
  assert.deepEqual(await logTaskTitles(client), ['Review']);
});

test('task requests serialize query values and JSON bodies through the generated client', async () => {
  const requests: Request[] = [];
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === 'POST') return Response.json(await request.clone().json(), { status: 201 });
      return Response.json([]);
    },
  });
  await readTaskPage(client, 'next/page');
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('cursor'), 'next/page');
  const created = await createTask(client, 'Publish the changelog');
  assert.deepEqual(created.body, { id: 'task-3', title: 'Publish the changelog' });
  assert.equal(requests[1].method, 'POST');
  assert.deepEqual(await requests[1].json(), created.body);
});

test('readTask propagates network failures and undeclared responses', async () => {
  const unavailable = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => { throw new TypeError('Connection unavailable'); },
  });
  await assert.rejects(readTask(unavailable, 'task-1'), /Connection unavailable/);

  const unexpected = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => Response.json({ message: 'Unavailable' }, { status: 503 }),
  });
  await assert.rejects(readTask(unexpected, 'task-1'), /Undeclared OpenAPI response/);
});

test('createTasksClient trims a trailing slash and rejects an empty baseUrl', async () => {
  const requests: Request[] = [];
  const client = createTasksClient({
    baseUrl: 'https://example.test/',
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json([]);
    },
  });
  await client.listTasks().execute({});
  assert.equal(requests[0].url, 'https://example.test/tasks');
  assert.throws(() => createTasksClient({ baseUrl: '   ' }), /non-empty baseUrl/);
});

test('readTask returns the title for a found task and the message for a declared 404', async () => {
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async (input) => {
      const request = new Request(input);
      if (request.url.endsWith('/tasks/missing')) {
        return Response.json({ message: 'This task no longer exists' }, { status: 404 });
      }
      assert.equal(request.url, 'https://example.test/tasks/folder%2Ftask');
      return Response.json({ id: 'folder/task', title: 'Review the draft' });
    },
  });
  assert.equal(await readTask(client, 'folder/task'), 'Review the draft');
  assert.equal(await readTask(client, 'missing'), 'This task no longer exists');
});

test('createTaskWithTitle reports a minLength issue for an empty title', async () => {
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => { throw new Error('fetch must not run when validation rejects the request'); },
  });
  const issues = await createTaskWithTitle(client, '');
  assert.ok(Array.isArray(issues));
  assert.ok(issues.some(([, path]) => (path as readonly unknown[]).includes('title')));
});

test('createTaskWithTitle sends a valid request through', async () => {
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async (input, init) => {
      const body = await new Request(input, init).clone().json();
      return Response.json(body, { status: 201 });
    },
  });
  const result = await createTaskWithTitle(client, 'Write release notes');
  assert.deepEqual(result, {
    matched: 'status',
    status: 201,
    contentType: 'application/json',
    body: { id: 'task-1', title: 'Write release notes' },
    headers: {},
  });
});

test('readTwoTasks reuses one operation for two requests', async () => {
  const requests: string[] = [];
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async (input) => {
      const url = new URL(new Request(input).url);
      requests.push(url.pathname);
      return Response.json({ id: url.pathname.split('/').pop(), title: 'Task' });
    },
  });
  const { first, second } = await readTwoTasks(client, 'task-1', 'task-2');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  if (first.status === 200 && second.status === 200) {
    assert.equal(first.body.id, 'task-1');
    assert.equal(second.body.id, 'task-2');
  }
  assert.deepEqual(requests, ['/tasks/task-1', '/tasks/task-2']);
});

test('createClientWithLocale sends Accept-Language on every request', async () => {
  const originalFetch = globalThis.fetch;
  let received: Request | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    received = new Request(input, init);
    return Response.json([]);
  }) as typeof fetch;
  try {
    const client = createClientWithLocale('https://example.test', 'en');
    assert.ok(client instanceof TasksClient);
    await client.listTasks().execute({});
    assert.equal(received?.headers.get('Accept-Language'), 'en');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listWithCancelButton aborts the pending request without throwing', async () => {
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
      // The signal may already be aborted by the time this runs: reacting to
      // the event alone would miss an abort that happened before this call.
      if (init?.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  });
  const button: { onclick: (() => void) | null } = { onclick: null };
  const result = listWithCancelButton(client, button);
  assert.equal(typeof button.onclick, 'function');
  button.onclick?.();
  assert.equal(await result, undefined);
});

test('fetchTask recognizes an undeclared response and reports it as undefined', async () => {
  const client = new TasksClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(null, { status: 418 }),
  });

  assert.equal(await fetchTask(client, 'task-1'), undefined);
});

test('loadTask converts wire data into a TaskModel instance', () => {
  const task = loadTask({ id: 'task-1', title: 'Write release notes' });
  assert.ok(task instanceof TaskModel);
  assert.equal(task.title, 'Write release notes');
});

test('readTaskDirectly imports the operation factory without the client class', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(new Request(input).url, 'https://example.test/tasks/task-1');
    return Response.json({ id: 'task-1', title: 'Review' });
  }) as typeof fetch;
  try {
    const response = await readTaskDirectly('https://example.test', 'task-1');
    assert.equal(response.status, 200);
    if (response.status === 200) assert.equal(response.body.title, 'Review');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
