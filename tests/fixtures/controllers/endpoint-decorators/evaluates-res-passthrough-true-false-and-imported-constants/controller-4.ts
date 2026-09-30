
import { Controller, Get, Res } from '@nestjs/common';

@Controller('manual-response-without-contract')
export class ManualResponseWithoutContractController {
  @Get()
  send(@Res() response: unknown): void {}
}
