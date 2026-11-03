import { identifier, tsSource, type SourceFragment } from '../../source-template.js';

export function clientConsumerSource(options: { readonly name: string }): SourceFragment {
  const client = identifier(`${options.name}Client`);
  const auth = identifier(`${options.name}Auth`);
  return tsSource`
import { ${client}, type ${auth} } from './client.js';
const auth: ${auth} = { bearer: 'token', constructor: undefined };
new ${client}({ baseUrl: 'https://api.example', auth });
new ${client}({ baseUrl: 'https://api.example' });
// @ts-expect-error Credentials retain their declared value types.
const invalid: ${auth} = { constructor: 123 };
void invalid;
`;
}
