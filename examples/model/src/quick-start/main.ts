// #region use-task
import { toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { Task } from './task.model.js';

const task = new Task({ title: 'Review the draft', done: false });
task.toggle();
console.log(toWireFormat<Task>(task)); // { title: 'Review the draft', done: true }
console.log(await validateInstance(task)); // []
// #endregion use-task
