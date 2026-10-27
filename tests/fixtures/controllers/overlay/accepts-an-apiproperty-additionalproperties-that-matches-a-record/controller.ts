import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';

class WidgetDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) scores!: Record<string, number>;
}

@Controller('widgets')
export class WidgetsController {
  @Get()
  @ApiOkResponse({ type: WidgetDto })
  get(): WidgetDto { return { scores: {} }; }
}
