// #region priority-word
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
// #endregion priority-word
