import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
class ItemDto { id!: string; }

@Controller('operation-hidden')
export class OperationHiddenController {
  @ApiOperation({ hidden: true, summary: 'stays in the document' })
  @Get()
  list(): ItemDto { return { id: '1' }; }
}
