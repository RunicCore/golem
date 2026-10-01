// #region model-definition
import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import { action, computed } from 'mobx';
import { TaskBaseModel } from './task.model.generated.js';

export type TTask = IModel<{ title: string; done: boolean }>;

export class Task extends TaskBaseModel {
  public constructor(values?: TTask) {
    super({ title: 'New task', done: false, ...values });
    asGenObservable(this, { label: computed, toggle: action });
  }

  public get label(): string {
    return `${this.done ? 'Done' : 'Todo'}: ${this.title}`;
  }

  public toggle(): void {
    this.done = !this.done;
  }
}
// #endregion model-definition
