
import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation } from '@nestjs/swagger';
class ItemDto { id!: string; }

@Controller('exclusion')
export class ExclusionController {
  @Get('kept')
  kept(): ItemDto { return { id: '1' }; }

  @ApiExcludeEndpoint(true)
  @ApiOperation({ hidden: false, summary: 'should stay excluded' })
  @Get('still-hidden')
  stillHidden(): ItemDto { return { id: '2' }; }

  @ApiOperation({ hidden: true })
  @Get('operation-hidden')
  operationHidden(): ItemDto { return { id: '3' }; }

  @ApiExcludeEndpoint(false)
  @Get('exclude-false')
  excludeFalse(): ItemDto { return { id: '4' }; }
}
