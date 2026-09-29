
import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/codegen/model';

export type TPayment = IModel<{ id: string } | { token: string }>;

@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() body: TPayment): TPayment { return body; }
}
