
import type { PingSurfacesClientOptions } from './client-runtime.js';
// Positive pairing for ping-client-assert.ts: an operation with a request
// body, response body, item-schema stream, and content-typed parameter has
// all four codec option fields, and each one accepts an override.
const options: PingSurfacesClientOptions = {
  baseUrl: 'https://example.test',
  bodyEncoders: {},
  responseDecoders: {},
  streamDecoders: {},
  parameterSerializers: {},
};
void options;
