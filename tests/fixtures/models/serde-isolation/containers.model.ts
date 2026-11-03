import type { IObject } from '@exprtlabs/golem/model';

export type TOpen = IObject<{ id: string }, { exact: false }>;
export type TContainers = IObject<{
  flags: Record<string, string>;
  tags: string[];
  matrix: string[][];
  open: TOpen;
  payload: unknown;
}, { allowAny: true }>;
