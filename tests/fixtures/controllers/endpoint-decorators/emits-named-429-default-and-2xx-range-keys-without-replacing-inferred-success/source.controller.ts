
import { Controller, Get, Res } from '@nestjs/common';
import { ApiDefaultResponse, ApiResponse, ApiTooManyRequestsResponse } from '@nestjs/swagger';
class ItemDto { id!: string; }
class ErrorDto { message!: string; }

@Controller('named')
export class NamedController {
  @ApiTooManyRequestsResponse({ description: 'slow down', type: ErrorDto })
  @ApiDefaultResponse({ description: 'fallback', type: ErrorDto })
  @Get('status')
  status(): ItemDto { return { id: '1' }; }

  @ApiResponse({ status: '2XX', description: 'success family', type: ItemDto })
  @Get('range')
  range(): ItemDto { return { id: '2' }; }

  @ApiResponse({ status: '2XX', content: { 'application/json': { schema: { type: 'string' } } } })
  @Get('manual')
  send(@Res() response: unknown): void {}
}
