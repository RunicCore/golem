import { autorun } from 'mobx';
import { createTask, saveTask } from './task-app.js';

const task = createTask({ title: 'Add MobX examples' });
const dispose = autorun(() => { console.info('model-mobx:', task.label); });
task.toggle();

const saved = saveTask(task);
dispose();
task.toggle();
console.info('model-mobx: saved task', saved);
