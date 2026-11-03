
import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint as Hide } from '@nestjs/swagger';
import { EXCLUDE, INCLUDE } from './flags.js';
class ItemDto { id!: string; }

@Controller('visibility')
export class VisibilityController {
  @Get('shown')
  shown(): ItemDto { return { id: '1' }; }

  @Hide()
  @Get('omitted')
  omitted(): ItemDto { return { id: '2' }; }

  @Hide(true)
  @Get('true')
  hiddenTrue(): ItemDto { return { id: '3' }; }

  @Hide(false)
  @Get('false')
  hiddenFalse(): ItemDto { return { id: '4' }; }

  @Hide(EXCLUDE)
  @Get('const-true')
  constTrue(): ItemDto { return { id: '5' }; }

  @Hide(INCLUDE)
  @Get('const-false')
  constFalse(): ItemDto { return { id: '6' }; }
}
