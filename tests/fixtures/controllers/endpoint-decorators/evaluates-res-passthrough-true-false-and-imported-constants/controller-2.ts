
import { Controller, Get, Res } from '@nestjs/common';
@Controller('manual-false')
export class ManualFalseController {
  @Get()
  send(@Res({ passthrough: false }) response: unknown): void {}
}
