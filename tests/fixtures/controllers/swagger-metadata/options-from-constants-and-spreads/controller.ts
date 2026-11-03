import { Controller, Get, Param } from '@nestjs/common';
import { ApiProperty, ApiResponse } from '@nestjs/swagger';

const SHARED = { description: 'Shared description', required: false } as const;
const BASE_ERROR = { description: 'Not found error' };

class ThingDto {
  @ApiProperty(SHARED)
  name?: string;

  @ApiProperty({ ...SHARED, description: 'Overridden description' })
  code?: string;
}

@Controller('things')
export class ThingsController {
  @Get(':id')
  @ApiResponse({ ...BASE_ERROR, status: 404 })
  get(@Param('id') id: string): ThingDto {
    return { name: id };
  }
}
