
import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/codegen/model';

export type TPayment = IModel<{ id: string }>;
type Maybe<T> = T | null;

@Controller('payments')
export class PaymentsController {
  @Post()
  save(@Body() body: Maybe<TPayment>): Maybe<TPayment> { return body; }
}
