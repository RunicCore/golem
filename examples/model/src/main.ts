import { createTask, saveTask } from './task-app.js';

const task = createTask({ title: 'Ship the generators' });

task.toggle();
const saved = await saveTask(task);

console.info('model: saved task', saved);
