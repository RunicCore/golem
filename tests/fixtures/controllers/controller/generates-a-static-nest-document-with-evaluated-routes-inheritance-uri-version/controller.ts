
import { Body, Controller, Get, Param, Post, Query, Version } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

class CatDto {
  id!: string;
  name?: string;
}

const routeFor = (input: { service: string; resource: string }) => '/' + input.service + '/' + input.resource;

class BaseController {
  @Get(':id')
  @ApiResponse({ status: 200, type: () => CatDto })
  find(@Param('id') id: string): Promise<CatDto> {
    return Promise.resolve({ id });
  }
}

@ApiTags('cats')
@Controller('cats')
export class CatsController extends BaseController {
  @Get(routeFor({ service: 'catalog', resource: 'list' }))
  @ApiOperation({ summary: 'List cats' })
  list(@Query('limit') limit?: number): Promise<CatDto[]> {
    return Promise.resolve([]);
  }

  @Version(['1', '2'])
  @Post()
  @ApiBody({ type: CatDto })
  @ApiBadRequestResponse({ description: 'Invalid input' })
  create(@Body() body: CatDto): CatDto {
    return body;
  }
}
