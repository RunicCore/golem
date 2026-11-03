
import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
let hide = true;
@Controller('unreadable-exclude')
export class UnreadableExcludeController {
  @ApiExcludeEndpoint(hide)
  @Get()
  get(): void {}
}
