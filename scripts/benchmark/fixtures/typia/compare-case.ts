export type CompareTask = 'validate' | 'decode' | 'encode';
/** One timed call of the typia comparison; the runner and the fixture module share this shape. */
export interface CompareCase { readonly model: string; readonly task: CompareTask; readonly side: string; readonly run: () => unknown }
