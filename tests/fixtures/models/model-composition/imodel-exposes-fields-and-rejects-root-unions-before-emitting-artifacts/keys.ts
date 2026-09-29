
import type { IModel } from '@exprtlabs/codegen/model';
type Item = IModel<{ id: string; count?: number }>;
const required: Required<Item> = { id: 'a', count: 1 };
const keys: keyof Item = 'id';
const fields: Item = required;
// @ts-expect-error no generated metadata keys
const wrong: keyof Item = 'fields';
void keys; void fields; void wrong;
