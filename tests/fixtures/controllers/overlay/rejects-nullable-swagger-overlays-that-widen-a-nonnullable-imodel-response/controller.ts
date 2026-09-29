
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/codegen/model';

export type TPayment = IModel<{ id: string }>;

@Controller('payments')
export class PaymentsController {
  @Get()
  @ApiOkResponse({ schema: { nullable: true } })
  get(): TPayment { return { id: 'p-1' }; }
}
