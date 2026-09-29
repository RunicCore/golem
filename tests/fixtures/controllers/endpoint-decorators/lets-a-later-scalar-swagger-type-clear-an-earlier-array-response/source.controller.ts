
import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
class ItemDto { id!: string; }

@Controller('array-to-scalar')
export class ArrayToScalarController {
  @ApiResponse({ status: 200, type: [ItemDto], description: 'list' })
  @Get('list')
  list(): ItemDto[] { return []; }

  @ApiResponse({ status: 200, type: ItemDto, description: 'one' })
  @ApiResponse({ status: 200, type: [ItemDto], description: 'list' })
  @Get('tuple')
  tuple(): ItemDto { return { id: '1' }; }

  @ApiResponse({ status: 200, type: ItemDto, isArray: false, description: 'one' })
  @ApiResponse({ status: 200, type: ItemDto, isArray: true, description: 'list' })
  @Get('flag')
  flag(): ItemDto { return { id: '2' }; }
}
