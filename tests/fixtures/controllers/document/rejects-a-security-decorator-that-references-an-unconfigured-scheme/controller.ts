
import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';

@ApiBearerAuth('missing')
@Controller('catalog')
export class CatalogController {
  @Get()
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  get(): string { return 'ok'; }
}
