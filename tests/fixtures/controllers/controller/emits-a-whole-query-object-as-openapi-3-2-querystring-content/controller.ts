
import { Controller, Get, Query } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

@Controller('search')
export class SearchController {
  @Get()
  @ApiResponse({ schema: { type: 'string' } })
  search(@Query() query: { page: number; term?: string }): string {
    return query.term ?? String(query.page);
  }
}
