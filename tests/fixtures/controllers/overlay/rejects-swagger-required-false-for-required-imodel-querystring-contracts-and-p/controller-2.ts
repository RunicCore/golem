
import { Controller, Get, Param } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';

@Controller('payments')
export class PaymentsController {
  @Get(':id')
  @ApiParam({ name: 'id', required: false })
  get(@Param('id') id: string): void { void id; }
}
