import * as nest from '@nestjs/common';
import type { TPaymentFilter, TPaymentInput } from './payment.model.js';
@nest.Controller('namespaced')
export class NamespacedController {
  @nest.Post()
  create(@nest.Body() input: TPaymentInput, @nest.Query() filter: TPaymentFilter): number { return input.note.length + (filter.limit?.length ?? 0); }
}
