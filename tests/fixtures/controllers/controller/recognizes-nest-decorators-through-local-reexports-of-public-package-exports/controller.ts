
import { Controller, Get } from './http.js';
import { ApiOkResponse } from '@nestjs/swagger';

class ResultDto { id!: string; }

@Controller('reexported')
export class ReexportedController {
  @Get()
  @ApiOkResponse({ type: ResultDto })
  get(): ResultDto { return { id: 'ok' }; }
}
