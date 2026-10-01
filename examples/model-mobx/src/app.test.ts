import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autorun, isObservableProp } from 'mobx';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { createTask, saveTask } from './task-app.js';
import { Task } from './task.model.js';
import type { TTask } from './task.model.js';
import { TaskBaseModel } from './task.model.generated.js';
import { observeTask } from './observe-task.js';

test('model-mobx app creates observable tasks and disposes reactions', async () => {
  const task = createTask({ title: 'Add MobX examples' });

  assert.equal(isObservableProp(task, 'done'), true);
  const labels: string[] = [];
  const dispose = autorun(() => { labels.push(task.label); });
  task.toggle();
  assert.deepEqual(labels, ['Todo: Add MobX examples', 'Done: Add MobX examples']);
  assert.equal('$validator' in task, false);

  const saved = saveTask(task);
  dispose();
  task.toggle();
  assert.equal(labels.length, 2);
  assert.deepEqual(saved, { title: 'Add MobX examples', done: true });
  assert.deepEqual(toWireFormat<TTask>(task), { title: 'Add MobX examples', done: false });
});

test('model-mobx app converts saved task JSON into a fresh observable task', async () => {
  const converted = fromWireFormat<Task>({ title: 'Converted task', done: true });

  assert.equal(isObservableProp(converted, 'done'), true);
  assert.deepEqual(saveTask(converted), { title: 'Converted task', done: true });
});

test('observeTask logs the label through autorun and stops the reaction', () => {
  const labels: string[] = [];
  const task = observeTask(label => labels.push(label));
  assert.deepEqual(labels, ['Todo: Write release notes', 'Done: Write release notes']);
  task.toggle();
  assert.equal(labels.length, 2);
});

test('asGenObservable(this) annotates declared IModel fields', () => {
  class BareTask extends TaskBaseModel {
    constructor(values?: TTask) {
      super(values);
      asGenObservable(this);
    }
  }
  const task = new BareTask({ title: 'One argument', done: false });
  assert.equal(isObservableProp(task, 'title'), true);
  assert.equal(isObservableProp(task, 'done'), true);
});
