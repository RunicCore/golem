
import { Controller, Get } from '@nestjs/common';
import { ApiBadRequestResponse, ApiResponse, ApiTooManyRequestsResponse } from '@nestjs/swagger';
class ItemDto { id!: string; }
class ErrorDto { message!: string; }

@ApiBadRequestResponse({ description: 'base 400', type: ErrorDto })
class BaseCatalogController {}

@ApiTooManyRequestsResponse({ description: 'derived 429', type: ErrorDto })
@Controller('derived')
export class DerivedCatalogController extends BaseCatalogController {
  @Get()
  list(): ItemDto { return { id: '1' }; }
}

@ApiBadRequestResponse({ description: 'derived 400', type: ErrorDto })
@Controller('merged-base')
export class MergedBaseController extends BaseCatalogController {
  @Get()
  list(): ItemDto { return { id: '2' }; }
}

@ApiResponse({ status: 429, description: 'skipped 429', type: ErrorDto }, { overrideExisting: false })
@Controller('skip-base')
export class SkipBaseController extends BaseCatalogController {
  @Get()
  list(): ItemDto { return { id: '3' }; }
}
