
import { Controller, Get } from '@nestjs/common';
import { ApiNoContentResponse } from '@nestjs/swagger';

@Controller('no-content-conflict')
export class NoContentConflictController {
  @Get()
  @ApiNoContentResponse()
  get(): void {}
}
