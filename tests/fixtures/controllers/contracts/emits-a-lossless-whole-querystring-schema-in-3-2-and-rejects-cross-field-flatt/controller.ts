
import { Controller, Get, Query } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';
import type { DependentRequired, Pattern, TSerde } from '@exprtlabs/golem/tags';

type IntegerText = string & Pattern<'^[0-9]+$'>;
export function encodeInteger(value: number): IntegerText { return String(value) as IntegerText; }
export function decodeInteger(value: IntegerText): number { return Number(value); }
type QueryInteger = number & TSerde<typeof encodeInteger, typeof decodeInteger>;
type FilterFields = {
  min?: QueryInteger;
  max?: QueryInteger;
} & DependentRequired<{ min: ['max'] }>;
export type TFilter = IModel<FilterFields>;

@Controller('search')
export class SearchController {
  @Get()
  search(@Query() query: TFilter): void { void query; }
}
