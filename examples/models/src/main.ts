import 'temporal-polyfill/global';
import { fromWireFormat, parse } from '@exprtlabs/golem/serde';
import { Attachment } from './attachment.model.js';
import { readContactKind } from './contact.model.js';
import { readMoney, writeMoney } from './estimate-json.js';
import { PermissionInput } from './permission-input.model.js';
import { Reminder } from './reminder.model.js';
import { Schedule } from './schedule.model.js';
import { createTask, toValidTaskJSON } from './task-app.js';
import { TaskInput } from './task-input.model.js';

// #region use-task
import { toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { Task } from './task.model.js';

const task = new Task({ title: 'Review the draft', done: false, priority: 2 });
task.toggle();
console.log(toWireFormat<Task>(task)); // { title: 'Review the draft', done: true, priority: 'normal' }
console.log(await validateInstance(task)); // []
// #endregion use-task

// The rest of `npm start`: one line per feature, each on a task-tracker field.
const taskJSON = await toValidTaskJSON(createTask({ title: 'Ship the generators', done: true, priority: 3 }));
console.log('task JSON:', taskJSON);
console.log('estimate:', writeMoney(readMoney('{"amount":"12.50","currency":"USD"}')));
console.log('contact kind:', readContactKind('{"value":{"kind":"phone","number":"555-0100"}}'));
console.log('attachment:', toWireFormat<Attachment>(new Attachment({ name: 'checksum.bin', content: Uint8Array.of(1, 2, 3) })));
console.log('reminder:', parse<Reminder>('{"title":"Call","remindAt":"2025-01-02T03:04:05.000Z"}').remindAt.toISOString());
console.log('schedule ends:', parse<Schedule>('{"startsAt":"2025-01-02T03:04:05Z","day":"2025-01-02","length":"PT1H30M"}').endsAt.toString());
console.log('permission bits:', fromWireFormat<PermissionInput>({ permissions: '0x5' }).permissions);
const blank = await validateInstance(new TaskInput({ title: ' ', done: false }));
console.log('blank title:', blank[0]?.message);
