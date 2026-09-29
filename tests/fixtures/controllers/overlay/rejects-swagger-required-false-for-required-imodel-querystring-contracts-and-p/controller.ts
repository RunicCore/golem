
import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/codegen/model';

export type TFilter = IModel<{ limit: number }>;

@Controller('payments')
export class PaymentsController {
  @Get()
  @ApiQuery({ name: 'filter', required: false })
  get(@Query() filter: TFilter): void { void filter; }
}
