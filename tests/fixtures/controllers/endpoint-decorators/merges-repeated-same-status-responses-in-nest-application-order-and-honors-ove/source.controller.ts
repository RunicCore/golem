
import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
class ItemDto { id!: string; }

@Controller('repeated')
export class RepeatedController {
  @ApiResponse({ status: 400, description: 'first' })
  @ApiResponse({ status: 400, description: 'second' })
  @Get('merged')
  merged(): ItemDto { return { id: '1' }; }

  @ApiResponse({ status: 400, description: 'skipped' }, { overrideExisting: false })
  @ApiResponse({ status: 400, description: 'kept' })
  @Get('override')
  override(): ItemDto { return { id: '2' }; }

  @ApiResponse({ status: 400, description: 'description only' })
  @ApiResponse({ status: 400, type: ItemDto, isArray: true, description: 'typed' })
  @Get('clear')
  clear(): ItemDto { return { id: '3' }; }
}
