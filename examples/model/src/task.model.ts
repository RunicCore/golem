// #region model-definition
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength, TSerde } from '@exprtlabs/golem/tags';
import { TaskBase } from './task.model.generated.js';

const PRIORITY_WORDS = ['low', 'normal', 'high'] as const;
export type PriorityWord = (typeof PRIORITY_WORDS)[number];

export function toPriorityWord(value: number): PriorityWord {
  const word = PRIORITY_WORDS[value - 1];
  if (!word) throw new RangeError('Priority must be 1, 2 or 3.');
  return word;
}

export function fromPriorityWord(word: PriorityWord): number {
  return PRIORITY_WORDS.indexOf(word) + 1;
}

export type TTask = IModel<{
  title: string & MinLength<1>;
  done: boolean;
  // Your code sorts by a number; the JSON carries a word.
  priority: number & TSerde<typeof toPriorityWord, typeof fromPriorityWord>;
}>;

export class Task extends TaskBase {
  public toggle(): void {
    this.done = !this.done;
  }
}
// #endregion model-definition
