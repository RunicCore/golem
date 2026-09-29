import { Body, Controller, Post } from '@nestjs/common';
import { type PaymentInput } from './payment.model.js';
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: PaymentInput[]): PaymentInput[] { return input; }
}