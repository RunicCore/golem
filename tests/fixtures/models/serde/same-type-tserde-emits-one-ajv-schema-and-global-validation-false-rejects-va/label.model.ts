import type { IObject } from '@exprtlabs/codegen/model';
import type { TSerde } from '@exprtlabs/codegen/tags';
export function identity(value: string): string { return value; }
export type TLabel = IObject<{ name: string & TSerde<typeof identity, typeof identity> }>;