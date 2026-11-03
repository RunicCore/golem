import { createTrackedApiOperation } from './api-operation.js';

export interface ApiOperation<Input, Result, Options = unknown> {
  execute(input: Input, options?: Options): Promise<Result>;
}

export type ApiOperationRun<Input, Result, Options = unknown> = (
  input: Input,
  options?: Options,
) => Promise<Result>;

export function createApiOperation<Input, Result, Options = unknown>(
  name: string,
  run: ApiOperationRun<Input, Result, Options>,
): ApiOperation<Input, Result, Options> {
  return createTrackedApiOperation(name, run);
}
export type {
  BodyEncoder, BodyEncoderContext, ClientOptions, EncodedBody, EncodingMetadata, MutualTlsTransport, OperationCodecs,
  ParameterSerializer, ParameterSerializerContext, RequestOptions, ResponseDecoder, ResponseHeaderDecoder, ResponseHeaderDecoderContext,
  RuntimeResponseContract, RuntimeSecuritySchemes, ServerObject, StreamDecoder, StreamDecoderContext, UndeclaredResponseError,
} from './client-runtime/core.js';
export type { AuthContext, BasicAuthValue, BasicCredentials, TokenAuthValue } from './client-runtime/security.js';
