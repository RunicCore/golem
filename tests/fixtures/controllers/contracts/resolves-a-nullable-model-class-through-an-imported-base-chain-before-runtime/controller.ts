
import { Controller, Get, Param } from '@nestjs/common';
import { Payment } from './payment.model.js';

type Maybe<T> = T | null;

@Controller('payments')
export class PaymentsController {
  @Get(':id')
  find(@Param('id') id: string): Maybe<Payment> { void id; return null; }
}
