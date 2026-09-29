import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Payment, type PaymentFilter, type PaymentInput, type TPayment } from './payment.model.js';
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: PaymentInput): TPayment { return { id: "1", ...input }; }
  @Post("as-class")
  createAsClass(@Body() input: Payment): TPayment { return input; }
  @Get()
  list(@Query() filter: PaymentFilter): TPayment[] { return []; }
}