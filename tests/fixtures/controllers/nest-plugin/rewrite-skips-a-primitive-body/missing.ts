import { parse } from '@exprtlabs/golem/serde';
type MissingModel = { id: string };
export function read(text: string) { return parse<MissingModel>(text); }
