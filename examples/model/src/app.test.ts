import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError } from '@exprtlabs/golem/errors';
import { fromWireFormat, parse, stringify, toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { createTask, saveTask } from './task-app.js';
import { Task } from './task.model.js';
import type { TTask } from './task.model.js';
import type { TaskJSON } from './task.model.generated.js';
import { readTask, readTaskData, writeTask } from './read-json.js';
import { Notebook } from './note.model.js';
import type { TNote } from './note.model.js';
import { validateTaskTitles } from './builtin-tags.model.js';
import { checkContracts } from './collection-tags.model.js';
import { checkTaskInput } from './task-input-checks.js';
import { checkPermissionInput } from './permission-input.model.js';
import { checkOrderInput } from './order-input.model.js';
import { checkTitleRule } from './title-rule.js';
import { checkServerErrors } from './server-errors.js';
import { loadInvalidTask } from './load-task.js';
import { isMoney, readMoney, writeMoney } from './money-json.js';
import { Wallet } from './money.model.js';

test('model app creates, converts, validates, and saves a task', async () => {
  const task = createTask({ title: 'Ship the generators' });

  assert.deepEqual(await validateInstance(task), []);
  task.toggle();
  assert.deepEqual(await saveTask(task), { title: 'Ship the generators', done: true, priority: 'normal' });

  const converted = parse<TTask>(stringify<TTask>(task));
  assert.deepEqual(toWireFormat<TTask>(converted), { title: 'Ship the generators', done: true, priority: 'normal' });
});

test('priority is a number in the model and a word in JSON', () => {
  const task = createTask({ title: 'Plan the release', priority: 3 });
  assert.equal(toWireFormat<TTask>(task).priority, 'high');
  assert.equal(fromWireFormat<Task>({ title: 'Plan the release', done: false, priority: 'low' }).priority, 1);
});

test('an unknown priority word fails conversion', () => {
  const wire = { title: 'Plan the release', done: false, priority: 'urgent' } as unknown as TaskJSON;
  assert.throws(() => fromWireFormat<Task>(wire), (error: unknown) => error instanceof LibError);
});

test('an empty title fails validation and blocks saving', async () => {
  const task = createTask({ title: '' });
  assert.deepEqual((await validateInstance(task)).map(issue => issue.path), [['title']]);
  await assert.rejects(saveTask(task), /invalid task/i);
});

test('model validation reports a type issue for a non-string title value', async () => {
  const invalid = new Task({ title: 42 as unknown as string, done: false, priority: 2 });
  const issues = await validateInstance(invalid, { failFast: false });
  assert.ok(issues.some(issue => issue.path.length === 1 && issue.path[0] === 'title' && issue.source === 'typescript'));
  await assert.rejects(saveTask(invalid), /invalid task/i);
});

test('JSON text round-trips through the class and the plain type', () => {
  const text = '{"title":"Read JSON","done":false,"priority":"high"}';
  const task = readTask(text);
  assert.ok(task instanceof Task);
  assert.equal(task.priority, 3);
  assert.equal(readTaskData(text) instanceof Task, false);
  assert.equal(writeTask(task), text);
});

test('IObject stays a plain object; IModel nesting it builds a class instance', () => {
  const note = parse<TNote>('{"text":"Buy milk"}');
  assert.equal(Object.getPrototypeOf(note), Object.prototype);
  assert.deepEqual(note, { text: 'Buy milk' });

  const text = '{"notes":[{"text":"Buy milk"}]}';
  const notebook = parse<Notebook>(text);
  assert.ok(notebook instanceof Notebook);
  assert.equal(Object.getPrototypeOf(notebook.notes[0]), Object.prototype);
  assert.deepEqual(notebook.notes, [{ text: 'Buy milk' }]);
  assert.equal(stringify<Notebook>(notebook), text);
});

test('a short title fails MinLength, a title over 80 characters fails MaxLength, and a normal one passes', async () => {
  assert.deepEqual(await validateTaskTitles(), [false, true, false]);
});

test('DependentRequired blocks billing without an address when a card is present', async () => {
  assert.deepEqual(await checkContracts(), [true, false]);
});

test('a custom field rule blocks a blank title until it is corrected', async () => {
  const result = await checkTaskInput();
  assert.equal(result.issueCount, 1);
  assert.equal(result.message, 'Enter a title.');
  assert.equal(result.fixed, true);
});

test('a TSerde tag converts a hex permission string and blocks a value missing the read bit', async () => {
  const result = await checkPermissionInput();
  assert.equal(result.accessPermissions, 5);
  assert.deepEqual(result.accessWire, { permissions: '0x5' });
  assert.equal(result.deniedPermissions, 2);
  assert.equal(result.deniedValid, false);
  assert.deepEqual(result.deniedWire, { permissions: '0x2' });
});

test('a nested field error reports an array path and clears once fixed', async () => {
  const result = await checkOrderInput();
  assert.deepEqual(result.firstIssuePath, ['items', 0, 'sku']);
  assert.equal(result.skuError, 'must NOT have fewer than 3 characters');
  assert.equal(result.fixedCount, 0);
});

test('an instance rule from extend() runs after generated checks', async () => {
  const result = await checkTitleRule();
  assert.equal(result.valid, false);
  assert.equal(result.message, 'Start the title with Ship.');
});

test('setErrors stores a server message that clear() removes', () => {
  const result = checkServerErrors();
  assert.equal(result.beforeClear, 'This title is already used.');
  assert.equal(result.afterClear, undefined);
});

test('a trusted conversion skips Ajv but still surfaces the issue on validateInstance', async () => {
  const result = await loadInvalidTask();
  assert.equal(result.message, 'must NOT have fewer than 1 characters');
  assert.equal(result.title, '');
});

test('an IObject round-trips as a plain object and rejects bad data', () => {
  const money = readMoney('{"amount":12.5,"currency":"USD"}');
  assert.deepEqual(money, { amount: 12.5, currency: 'USD' });
  assert.equal(writeMoney(money), '{"amount":12.5,"currency":"USD"}');
  assert.equal(isMoney({ amount: -1, currency: 'USD' }), false);
  assert.throws(() => readMoney('{"amount":1,"currency":"GBP"}'), (error: unknown) => error instanceof LibError);
});

test('the Wallet IModel nests the TMoney IObject', async () => {
  const wallet = new Wallet({ balance: { amount: 5, currency: 'USD' } });
  assert.deepEqual(await validateInstance(wallet), []);
  assert.deepEqual(toWireFormat<Wallet>(wallet), { balance: { amount: 5, currency: 'USD' } });
});
