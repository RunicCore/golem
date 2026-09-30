import type { IObject } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
export function identity(value: string): string { return value; }
export type TLabel = IObject<{ name: string & TSerde<typeof identity, typeof identity> }>;