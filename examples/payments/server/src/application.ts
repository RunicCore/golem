// #region global-model-http
import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory, type AbstractHttpAdapter } from '@nestjs/core';
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
import { PaymentNotesController } from './payment-notes.controller.js';
import { PaymentsController } from './payments.controller.js';
import { ProviderCharges, type ProviderOptions } from './provider-charges.js';
// Load the model module so its generated codec is registered before requests arrive.
import './payment.model.js';

@Module({
  controllers: [PaymentsController, PaymentNotesController],
})
class PaymentsModule {
  static with(provider: ProviderOptions): DynamicModule {
    return { module: PaymentsModule, providers: [{ provide: ProviderCharges, useValue: new ProviderCharges(provider) }] };
  }
}

export async function createApplication(adapter?: AbstractHttpAdapter, provider: ProviderOptions = {}) {
  const application = adapter
    ? await NestFactory.create(PaymentsModule.with(provider), adapter, { logger: false })
    : await NestFactory.create(PaymentsModule.with(provider), { logger: false });
  application.setGlobalPrefix('api');
  // @Body() and @Query() become the declared model before the handler.
  // An IModel or IObject return is written as that type's JSON.
  application.useGlobalInterceptors(new NestModelInterceptor());
  return application;
}
// #endregion global-model-http
