import { Body, Controller, Post } from '@nestjs/common';
import type { TPayment, TPaymentInput } from './payment.model.js';
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: TPaymentInput): TPayment { return { id: '1', ...input }; }
}
