// #region observe-task
import { autorun } from 'mobx';
import { Task } from './task.model.js';

export function observeTask(report: (label: string) => void = console.log): Task {
  const task = new Task({ title: 'Write release notes', done: false });
  const stop = autorun(() => report(task.label));
  task.toggle(); // autorun logs: Done: Write release notes
  stop();
  return task;
}
// #endregion observe-task
