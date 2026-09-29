
import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/codegen/model';
import type { Minimum, Pattern, TSerde } from '@exprtlabs/codegen/tags';

type AmountText = string & Pattern<'^[0-9]+$'>;
export function encodeAmount(value: number): AmountText { return String(value) as AmountText; }
export function decodeAmount(value: AmountText): number { return Number(value); }
type Amount = number & Minimum<0> & TSerde<typeof encodeAmount, typeof decodeAmount>;
export type TPayment = IModel<{ amount: Amount }>;

@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() body: TPayment): TPayment { return body; }
}
