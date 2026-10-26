import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { LibError } from '@exprtlabs/golem/errors';
import { fromWireFormat, parse, stringify, toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { createTask, saveTask } from './task-app.js';
import { Task } from './task.model.js';
import { readOrder, writeOrder } from './order-json.js';
import type { TTask } from './task.model.js';
import type { TTaskJSON } from './task.model.generated.js';
import { readTask, readTaskData, writeTask } from './read-json.js';
import { Thread } from './comment.model.js';
import type { TComment } from './comment.model.js';
import { validateTaskTitles } from './builtin-tags.model.js';
import { validateHandles } from './tag-aliases.model.js';
import { checkSubscription } from './collection-tags.model.js';
import { checkTaskInput } from './task-input-checks.js';
import { checkPermissionInput } from './permission-input.model.js';
import { checkChecklistInput } from './checklist-input.model.js';
import { checkTitleRule } from './title-rule.js';
import { checkServerErrors } from './server-errors.js';
import { loadInvalidTask } from './load-task.js';
import { explainTaskText } from './read-errors.js';
import { isMoney, readMoney, writeMoney } from './estimate-json.js';
import { Budget } from './estimate.model.js';
import { describeAttachment } from './attachment-json.js';
import { readReminder } from './read-reminder.js';
import { readSchedule, writeSchedule } from './read-schedule.js';
import { Place, loadAssignee } from './assignee.model.js';
import { readContactKind } from './contact.model.js';
import { readIntegrationPayload, readLabelName, rejectsExtraProperty } from './metadata.model.js';

// Run a snippet that logs to the console and return what it logged.
async function capture<T>(run: () => T | Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const log = mock.method(console, 'log', () => undefined);
  try {
    const result = await run();
    return { result, logged: log.mock.calls.map(call => call.arguments) };
  } finally {
    log.mock.restore();
  }
}

test('model app creates, converts, validates, and saves a task', async () => {
  const task = createTask({ title: 'Ship the generators' });

  assert.deepEqual(await validateInstance(task), []);
  task.toggle();
  assert.deepEqual(await saveTask(task), { title: 'Ship the generators', done: true, priority: 'normal' });

  const converted = parse<TTask>(stringify<TTask>(task));
  assert.deepEqual(toWireFormat<TTask>(converted), { title: 'Ship the generators', done: true, priority: 'normal' });
});

test('quick start toggles a task, serializes it and validates it', async () => {
  const info = mock.method(console, 'info', () => undefined);
  try {
    const { logged } = await capture(() => import('./main.js'));
    assert.deepEqual(logged, [
      [{ title: 'Review the draft', done: true, priority: 'normal' }],
      [[]],
    ]);
    assert.deepEqual(info.mock.calls[0]?.arguments, ['saved task:', { title: 'Ship the generators', done: true, priority: 'high' }]);
    assert.equal(info.mock.calls.length, 8);
    assert.deepEqual(info.mock.calls.at(-1)?.arguments, ['blank title:', 'Enter a title.']);
  } finally {
    info.mock.restore();
  }
});

test('a LibError of input lists the failed checks by path', () => {
  // protects: fact F-83 LibError issues and causedByInput
  assert.deepEqual(explainTaskText('{"title":"Plan","done":false,"priority":"low"}'), []);
  const failed = explainTaskText('{"title":"","done":"no","priority":"low"}');
  assert.deepEqual(failed.map(line => line.split(':')[0]).sort(), ['done', 'title']);
  assert.equal(explainTaskText('not json').length, 1);
});

test('priority is a number in the model and a word in JSON', () => {
  const task = createTask({ title: 'Plan the release', priority: 3 });
  assert.equal(toWireFormat<TTask>(task).priority, 'high');
  assert.equal(fromWireFormat<Task>({ title: 'Plan the release', done: false, priority: 'low' }).priority, 1);
});

test('an unknown priority word fails conversion', () => {
  const wire = { title: 'Plan the release', done: false, priority: 'urgent' } as unknown as TTaskJSON;
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
  const comment = parse<TComment>('{"text":"Looks good"}');
  assert.equal(Object.getPrototypeOf(comment), Object.prototype);
  assert.deepEqual(comment, { text: 'Looks good' });

  const text = '{"comments":[{"text":"Looks good"}]}';
  const thread = parse<Thread>(text);
  assert.ok(thread instanceof Thread);
  assert.equal(Object.getPrototypeOf(thread.comments[0]), Object.prototype);
  assert.deepEqual(thread.comments, [{ text: 'Looks good' }]);
  assert.equal(stringify<Thread>(thread), text);
});

test('built-in tags, a generic alias and collection tags each reject their own bad value', async () => {
  assert.deepEqual(await validateTaskTitles(), [false, true, false]);
  assert.deepEqual(await validateHandles(), [true, false]);
  assert.deepEqual(await checkSubscription(), [true, false]);
});

test('a custom field rule blocks a blank title until it is corrected', async () => {
  const { result } = await capture(checkTaskInput);
  assert.equal(result.issueCount, 1);
  assert.equal(result.message, 'Enter a title.');
  assert.equal(result.fixed, true);
});

test('a TSerde tag converts a hex permission string and blocks a value missing the read bit', async () => {
  const { result } = await capture(checkPermissionInput);
  assert.equal(result.accessPermissions, 5);
  assert.deepEqual(result.accessWire, { permissions: '0x5' });
  assert.equal(result.deniedPermissions, 2);
  assert.equal(result.deniedValid, false);
  assert.deepEqual(result.deniedWire, { permissions: '0x2' });
});

test('a nested field error reports an array path and clears once fixed', async () => {
  const { result } = await capture(checkChecklistInput);
  assert.deepEqual(result.firstIssuePath, ['items', 0, 'label']);
  assert.equal(result.labelError, 'Must be at least 3 characters');
  assert.equal(result.fixedCount, 0);
});

test('an instance rule from extend() runs after generated checks', async () => {
  const { result } = await capture(checkTitleRule);
  assert.equal(result.valid, false);
  assert.equal(result.message, 'Start the title with Ship.');
});

test('setErrors stores a server message that clear() removes', async () => {
  const { result } = await capture(checkServerErrors);
  assert.equal(result.beforeClear, 'This title is already used.');
  assert.equal(result.afterClear, undefined);
});

test('a trusted conversion skips validation but still surfaces the issue on validateInstance', async () => {
  const { result } = await capture(loadInvalidTask);
  assert.equal(result.message, 'Must be at least 1 character');
  assert.equal(result.title, '');
});

test('money is a decimal string: an IObject round-trips "12.50" exactly and rejects bad data', () => {
  const money = readMoney('{"amount":"12.50","currency":"USD"}');
  assert.deepEqual(money, { amount: '12.50', currency: 'USD' });
  assert.equal(writeMoney(money), '{"amount":"12.50","currency":"USD"}');
  assert.equal(isMoney({ amount: 12.5, currency: 'USD' }), false);
  assert.equal(isMoney({ amount: '12.505', currency: 'USD' }), false);
  assert.equal(isMoney({ amount: '12.50', currency: 'usd' }), false);
  assert.throws(() => readMoney('{"amount":"-1","currency":"USD"}'), (error: unknown) => error instanceof LibError);
});

test('the Budget IModel nests the TMoney IObject', async () => {
  const budget = new Budget({ estimate: { amount: '5.00', currency: 'USD' } });
  assert.deepEqual(await validateInstance(budget), []);
  assert.deepEqual(toWireFormat<Budget>(budget), { estimate: { amount: '5.00', currency: 'USD' } });
});

test('a field typed with a class holds an instance and a derived type stays a plain object', async () => {
  const { result, logged } = await capture(loadAssignee);
  assert.ok(result.office instanceof Place);
  assert.equal(Object.getPrototypeOf(result.site), Object.prototype);
  assert.deepEqual(logged, [[true], [true]]);
});

test('a discriminated union converts by its kind', () => {
  assert.equal(readContactKind('{"value":{"kind":"email","address":"a@example.test"}}'), 'email');
  assert.equal(readContactKind('{"value":{"kind":"phone","number":"555"}}'), 'phone');
});

test('exact models reject extra properties, open models accept them and allowAny skips structure', () => {
  const text = '{"name":"Ada","extra":1}';
  assert.equal(rejectsExtraProperty(text), true);
  assert.equal(readLabelName(text), 'Ada');
  assert.deepEqual(readIntegrationPayload('{"payload":{"anything":[1,"two"]}}'), { anything: [1, 'two'] });
});

test('a Date field is an ISO string in JSON and a Date in the model', async () => {
  const { result, logged } = await capture(() => readReminder('{"title":"Call","remindAt":"2025-01-02T03:04:05.000Z"}'));
  assert.equal(result.remindAt.toISOString(), '2025-01-02T03:04:05.000Z');
  assert.deepEqual(logged, [[true]]);
});

test('Temporal fields hold Temporal values and write ISO 8601 strings', async () => {
  const text = '{"startsAt":"2025-01-02T03:04:05Z","day":"2025-01-02","length":"PT1H30M"}';
  const { result, logged } = await capture(() => readSchedule(text));
  assert.ok(result.day instanceof Temporal.PlainDate);
  assert.equal(writeSchedule(result), text);
  assert.deepEqual(logged, [[true], ['2025-01-02T04:34:05Z']]);
});

test('a TSerde field can hold a class instance such as Uint8Array', async () => {
  const { result, logged } = await capture(describeAttachment);
  assert.deepEqual(result.wire, { name: 'checksum.bin', content: 'AQID' });
  assert.deepEqual([...result.copy.content], [1, 2, 3]);
  assert.deepEqual(logged, [[true]]);
});

test('an order reads decimal text, a priority word and a Date, and writes the same JSON back', () => {
  // protects: task T-455 one model with money text, a priority word and a Date
  const text = '{"amount":"12.50","priority":"high","remindAt":"2025-01-02T03:04:05.000Z"}';
  const order = readOrder(text);

  assert.equal(order.amount, 1250);
  assert.equal(order.priority, 3);
  assert.equal(order.remindAt.toISOString(), '2025-01-02T03:04:05.000Z');
  assert.equal(writeOrder(order), text);
});
