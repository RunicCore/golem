
import type { PingClientOptions } from './client.js';
const options: PingClientOptions = { baseUrl: 'https://example.test' };
// @ts-expect-error an operation with no request or response bodies has no codecs to override
void ({ ...options, bodyEncoders: {} } satisfies PingClientOptions);
// @ts-expect-error an operation with no request or response bodies has no codecs to override
void ({ ...options, responseDecoders: {} } satisfies PingClientOptions);
// @ts-expect-error an operation with no request or response bodies has no codecs to override
void ({ ...options, streamDecoders: {} } satisfies PingClientOptions);
// @ts-expect-error an operation with no request or response bodies has no codecs to override
void ({ ...options, parameterSerializers: {} } satisfies PingClientOptions);
void options;
