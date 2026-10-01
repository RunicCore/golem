import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBadGatewayResponse, ApiBadRequestResponse, ApiNotFoundResponse, ApiOperation } from '@nestjs/swagger';
import { PaymentDraft } from './payment-draft.model.js';
import { Payment, type TPaymentFilter, type TPaymentInput, type TPayment } from './payment.model.js';
import { ProviderCharges } from './provider-charges.js';
import { routes } from './routes.js';

const payments = new Map<string, TPayment>();
let nextPaymentId = 1;

// #region route-helper-method
@Controller(routes.resource({ service: 'payments', resource: 'transactions' }))
// #endregion route-helper-method
export class PaymentsController {
  public constructor(private readonly provider: ProviderCharges) {}

  // TPaymentInput is an IObject, so input arrives as a validated plain object.
  // #region create-payment
  @Post()
  @ApiOperation({ operationId: 'createPayment' })
  @ApiBadRequestResponse({ description: 'Invalid payment input.' })
  @ApiBadGatewayResponse({ description: 'The payment provider declined or is unavailable.' })
  async create(@Body() input: TPaymentInput): Promise<TPayment> {
    const id = String(nextPaymentId++);
    const charge = await this.provider.charge(input.money, `payment-${id}`);
    const payment = { id, ...input, charge };
    payments.set(payment.id, payment);
    return payment;
  }
  // #endregion create-payment

  // Payment is your class, so input arrives as a Payment instance.
  @Post('as-class')
  @ApiOperation({ operationId: 'createPaymentAsClass' })
  @ApiBadRequestResponse({ description: 'Invalid payment.' })
  createAsClass(@Body() input: Payment): TPayment {
    const payment = {
      id: input.id,
      merchant: input.merchant,
      billing: input.billing,
      money: input.money,
      note: input.note,
    };
    payments.set(payment.id, payment);
    return payment;
  }

  // #region draft-method
  @Post('drafts')
  createDraft(@Body() input: PaymentDraft): PaymentDraft {
    // { note: 'Lunch' } is a PaymentDraft instance.
    // The HTTP response is that type's JSON.
    // { note: '' } is HTTP 400 before this method runs.
    return input;
  }
  // #endregion draft-method

  // @Param() stays a string; the interceptor does not convert it.
  @Get(':id')
  @ApiOperation({ operationId: 'getPayment' })
  @ApiNotFoundResponse({ description: 'Payment not found.' })
  get(@Param('id') id: string): TPayment {
    const payment = payments.get(id);
    if (!payment) throw new NotFoundException();
    return payment;
  }

  // #region query-method
  @Get()
  @ApiOperation({ operationId: 'listPayments' })
  @ApiBadRequestResponse({ description: 'Invalid query.' })
  list(@Query() filter: TPaymentFilter): TPayment[] {
    return [...payments.values()].slice(0, filter.limit ?? 20);
  }
  // #endregion query-method

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'deletePayment' })
  remove(@Param('id') id: string): void {
    payments.delete(id);
  }
}
