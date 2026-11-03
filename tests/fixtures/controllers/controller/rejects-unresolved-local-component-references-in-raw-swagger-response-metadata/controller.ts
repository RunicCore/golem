
import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

@Controller('unresolved-ref')
export class UnresolvedReferenceController {
  @Get()
  @ApiResponse({ schema: { $ref: '#/components/schemas/MissingResponse' } })
  get(): void {}
}
