import { parse } from '@exprtlabs/golem/serde';
import type DefaultClass from './default-class.model.js';

declare const text: string;
export const parsed = parse<DefaultClass>(text);
