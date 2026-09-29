import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiSchema, getSchemaPath } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/codegen/model';

export type TPayment = IModel<{ amount: number }>;

@ApiSchema({ name: 'PageMetadata' })
class PageMeta {
  @ApiProperty({ description: 'Total rows' })
  total!: number;
}

@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() body: TPayment): TPayment {
    return body;
  }

  @Get()
  @ApiOkResponse({ schema: { $ref: getSchemaPath(PageMeta) } })
  page(): void {}
}
