// #region global-model-http
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory, type AbstractHttpAdapter } from '@nestjs/core';
import { NestModelInterceptor } from '@exprtlabs/codegen/nest';
import { PaymentsController } from './payments.controller.js';
// Load the model module so its generated codec is registered before requests arrive.
import './payment.model.js';

@Module({
  controllers: [PaymentsController],
})
class PaymentsModule {}

export async function createApplication(adapter?: AbstractHttpAdapter) {
  const application = adapter
    ? await NestFactory.create(PaymentsModule, adapter, { logger: false })
    : await NestFactory.create(PaymentsModule, { logger: false });
  application.setGlobalPrefix('api');
  // @Body() and @Query() become the declared model before the handler.
  // An IModel or IObject return is written as that type's JSON.
  application.useGlobalInterceptors(new NestModelInterceptor());
  return application;
}
// #endregion global-model-http
