
import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/golem/model';

export type TPayment = IModel<{ id: string; amount: number }>;

@Controller('payments')
export class PaymentsController {
  @Get()
  @ApiResponse({ schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } })
  get(): TPayment {
    return { id: 'p-1', amount: 10 };
  }
}
