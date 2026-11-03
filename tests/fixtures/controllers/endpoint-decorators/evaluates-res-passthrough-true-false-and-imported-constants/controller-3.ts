
import { Controller, Get, Res } from '@nestjs/common';
import { MANUAL } from './flags.js';
@Controller('manual-false-const')
export class ManualFalseConstController {
  @Get()
  send(@Res({ passthrough: MANUAL }) response: unknown): void {}
}
