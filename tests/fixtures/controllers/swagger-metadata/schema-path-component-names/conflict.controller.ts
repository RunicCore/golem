import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiSchema, getSchemaPath } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/golem/model';

export type TPayment = IModel<{ amount: number }>;

@ApiSchema({ name: 'Payment' })
class PaymentSummary {
  @ApiProperty()
  count!: number;
}

@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() body: TPayment): TPayment {
    return body;
  }

  @Get('summary')
  @ApiOkResponse({ schema: { $ref: getSchemaPath(PaymentSummary) } })
  summary(): void {}
}
