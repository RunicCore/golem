import { parse } from '@exprtlabs/codegen/serde';
type MissingModel = { id: string };
export function read(text: string) { return parse<MissingModel>(text); }
