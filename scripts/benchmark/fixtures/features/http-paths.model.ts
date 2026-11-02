import type { IModel } from '@exprtlabs/golem/model';
import { TNestQueryBaseModel } from './http-paths.model.generated.js';

/** The query model of a NestJS handler: six fields that arrive as strings (a number, a boolean, two lists, an optional string and a date). */
export type TNestQuery = IModel<{ limit: number; active: boolean; ids: number[]; tags: string[]; q?: string; since: Date }>;
export class NestQuery extends TNestQueryBaseModel {}
