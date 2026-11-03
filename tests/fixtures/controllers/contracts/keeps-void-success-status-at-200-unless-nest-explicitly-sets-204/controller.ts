
import { Controller, Delete, Get, HttpCode } from '@nestjs/common';

@Controller('status')
export class StatusController {
  @Get('default')
  defaultStatus(): void {}

  @Delete('explicit')
  @HttpCode(204)
  explicitStatus(): void {}
}
