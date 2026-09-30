import { Controller, Get } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { positive } from './predicates.js';

export type TCatalogItem = IModel<{ value: number & TValidation<typeof positive> }>;

@Controller('catalog')
export class CatalogController {
  @Get()
  list(): TCatalogItem { return { value: 1 }; }
}
