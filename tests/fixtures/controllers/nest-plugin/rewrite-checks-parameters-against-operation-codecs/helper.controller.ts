import { Query } from '@nestjs/common';
import type { TPaymentFilter } from './payment.model.js';
export class Helper {
  read(@Query() filter: TPaymentFilter): number { return filter.limit?.length ?? 0; }
}
