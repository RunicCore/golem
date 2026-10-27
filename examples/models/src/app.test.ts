import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError } from '@exprtlabs/golem/errors';
import { fromWireFormat, parse, stringify, toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { createTask, saveTask } from './task-app.js';
import { Task } from './task.model.js';
import { readOrder, writeOrder } from './order-json.js';
import type { TTask } from './task.model.js';
import type { TTaskJSON } from './task.model.generated.js';
import { readTask, readTaskData } from './read-json.js';
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
import { roundTripAttachment } from './attachment-json.js';
import { Attachment } from './attachment.model.js';
import { readReminder } from './read-reminder.js';
import { readSchedule, writeSchedule } from './read-schedule.js';
import { Place, loadAssignee } from './assignee.model.js';
import { readContactKind } from './contact.model.js';
import { readIntegrationPayload, readLabelName, rejectsExtraProperty } from './metadata.model.js';

test('model app creates, converts, validates, and saves a task', async () => {
  const task = createTask({ title: 'Ship the generators' });

  assert.deepEqual(await validateInstance(task), []);
  task.toggle();
  assert.deepEqual(await saveTask(task), { title: 'Ship the generators', done: true, priority: 'normal' });

  const converted = parse<TTask>(stringify<TTask>(task));
  assert.deepEqual(toWireFormat<TTask>(converted), { title: 'Ship the generators', done: true, priority: 'normal' });
});

test('a LibError of input lists the failed checks by path', () => {
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
  assert.equal(stringify<TTask>(task), text);
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
  assert.deepEqual(await checkTaskInput(), { blank: ['Enter a title.'], fixed: true });
});

test('a TSerde tag converts a hex permission string and blocks a value missing the read bit', async () => {
  assert.deepEqual(await checkPermissionInput(), {
    permissions: 5,
    wire: { permissions: '0x5' },
    deniedMessage: 'Read permission is required.',
  });
});

test('a nested field error reports an array path and clears once fixed', async () => {
  assert.deepEqual(await checkChecklistInput(), {
    firstIssuePath: ['items', 0, 'label'],
    labelError: 'Must be at least 3 characters',
    fixedCount: 0,
  });
});

test('an instance rule from extend() runs after generated checks', async () => {
  assert.deepEqual(await checkTitleRule(), { valid: false, message: 'Start the title with Ship.' });
});

test('setErrors stores a server message that clear() removes', async () => {
  assert.deepEqual(checkServerErrors(), { beforeClear: 'This title is already used.', afterClear: undefined });
});

test('a trusted conversion skips validation but still surfaces the issue on validateInstance', async () => {
  assert.deepEqual(await loadInvalidTask(), { message: 'Must be at least 1 character', title: '' });
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

test('a field typed with a class holds an instance and a derived type stays a plain object', () => {
  const assignee = loadAssignee();
  assert.ok(assignee.office instanceof Place);
  assert.equal(Object.getPrototypeOf(assignee.site), Object.prototype);
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

test('a Date field is an ISO string in JSON and a Date in the model', () => {
  const reminder = readReminder('{"title":"Call","remindAt":"2025-01-02T03:04:05.000Z"}');
  assert.ok(reminder.remindAt instanceof Date);
  assert.equal(reminder.remindAt.toISOString(), '2025-01-02T03:04:05.000Z');
});

test('Temporal fields hold Temporal values and write ISO 8601 strings', () => {
  const text = '{"startsAt":"2025-01-02T03:04:05Z","day":"2025-01-02","length":"PT1H30M"}';
  const schedule = readSchedule(text);
  assert.ok(schedule.startsAt instanceof Temporal.Instant);
  assert.ok(schedule.day instanceof Temporal.PlainDate);
  assert.equal(schedule.endsAt.toString(), '2025-01-02T04:34:05Z');
  assert.equal(writeSchedule(schedule), text);
});

test('a TSerde field can hold a class instance such as Uint8Array', () => {
  const { wire, copy } = roundTripAttachment();
  assert.deepEqual(wire, { name: 'checksum.bin', content: 'AQID' });
  assert.ok(copy.content instanceof Uint8Array);
  assert.deepEqual([...copy.content], [1, 2, 3]);
});

test('the base64 codec round-trips a 200 KB attachment', () => {
  const content = Uint8Array.from({ length: 200_000 }, (_, index) => index % 256);
  const attachment = new Attachment({ name: 'large.bin', content });
  const copy = parse<Attachment>(stringify<Attachment>(attachment));
  assert.deepEqual(copy.content, content);
});

test('malformed base64 is rejected as input', () => {
  assert.throws(
    () => parse<Attachment>('{"name":"short.bin","content":"A"}'),
    (error: unknown) => error instanceof LibError && error.causedByInput,
  );
});

test('an order reads decimal text, a priority word and a Date, and writes the same JSON back', () => {
  const text = '{"amount":"12.50","priority":"high","remindAt":"2025-01-02T03:04:05.000Z"}';
  const order = readOrder(text);

  assert.equal(order.amount, 1250);
  assert.equal(order.priority, 3);
  assert.equal(order.remindAt.toISOString(), '2025-01-02T03:04:05.000Z');
  assert.equal(writeOrder(order), text);
});
