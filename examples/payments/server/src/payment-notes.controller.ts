// #region payment-note-controller
import { Controller, Get, Param } from '@nestjs/common';

interface PaymentNote {
  id: string;
  note: string;
}

@Controller('payment-notes')
export class PaymentNotesController {
  @Get(':id')
  public get(@Param('id') id: string): PaymentNote {
    return { id, note: 'Order 123' };
  }
}
// #endregion payment-note-controller
