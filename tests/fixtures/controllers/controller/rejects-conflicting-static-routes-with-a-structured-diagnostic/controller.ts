
import { Controller, Get } from '@nestjs/common';

@Controller('conflicts')
export class ConflictsController {
  @Get('same')
  first(): void {}

  @Get('same')
  second(): void {}
}
