import type { ClientHelperName, EmissionPlan } from '../emission-plan.js';
import type { OpenApiGenerationProfile } from '../profile.js';

function when(helpers: ReadonlySet<ClientHelperName>, name: ClientHelperName, source: string): string {
  return helpers.has(name) ? source : '';
}

export function emitStreamMethods(
  clientName: string,
  _profile: OpenApiGenerationProfile,
  plan: EmissionPlan,
): string {
  const helpers = plan.helpers;
  return `
${when(helpers, 'validateStreamItems', `
  private async *validateStreamItems<T>(
    operation: OperationName,
    selected: { status: string; contentType: string | null },
    stream: AsyncIterable<unknown>,
    validators: OperationRuntimeValidators | undefined,
  ): AsyncIterable<T> {
    const validator = this.responseValidator(operation, selected, validators);
    for await (const item of stream) {
      await this.assertValid(validator, item);
      yield item as T;
    }
  }
`)}
${when(helpers, 'readNdjson', `
  private async *readNdjson<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const reader = stream.getReader();
    const decoder = new TextDecoder(undefined, { fatal: true });
    let buffered = '';
    let completed = false;
    const parseLine = (line: string): T | undefined => {
      const value = line.trim();
      if (!value) return undefined;
      try {
        return JSON.parse(value) as T;
      } catch (error) {
        throw new Error(\`Malformed NDJSON record: \${error instanceof Error ? error.message : String(error)}\`);
      }
    };
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        buffered += decoder.decode(result.value, { stream: true });
        const lines = buffered.split(/\\r?\\n/);
        buffered = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseLine(line);
          if (parsed !== undefined) yield parsed;
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) {
        const parsed = parseLine(buffered);
        if (parsed !== undefined) yield parsed;
      }
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
`)}
${when(helpers, 'readJsonSeq', `
  private async *readJsonSeq<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const reader = stream.getReader();
    const decoder = new TextDecoder(undefined, { fatal: true, ignoreBOM: true });
    let buffered = '';
    let sawRecordSeparator = false;
    let completed = false;
    const parseRecord = (record: string): T | undefined => {
      if (!record.trim()) return undefined;
      try {
        const parsed = JSON.parse(record) as T;
        if ((parsed === null || typeof parsed !== 'object') && !/\\s$/u.test(record)) {
          throw new Error('JSON text sequence primitive must end with JSON whitespace');
        }
        return parsed;
      } catch (error) {
        throw new Error(\`Malformed JSON text sequence record: \${error instanceof Error ? error.message : String(error)}\`);
      }
    };
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        buffered += decoder.decode(result.value, { stream: true });
        const records = buffered.split('\\u001e');
        buffered = records.pop() || '';
        for (const record of records) {
          if (!sawRecordSeparator) {
            if (record.length > 0) throw new Error('JSON text sequence requires an RS before the first record');
            sawRecordSeparator = true;
            continue;
          }
          const parsed = parseRecord(record);
          if (parsed !== undefined) yield parsed;
        }
      }
      buffered += decoder.decode();
      if (!sawRecordSeparator) {
        if (buffered.length > 0) throw new Error('JSON text sequence requires an RS before the first record');
      } else if (buffered.trim()) {
        const parsed = parseRecord(buffered);
        if (parsed !== undefined) yield parsed;
      }
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
`)}
${when(helpers, 'readServerSentEvents', `
  private async *readServerSentEvents<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const reader = stream.getReader();
    const decoder = new TextDecoder(undefined, { fatal: true });
    let buffered = '';
    let event = '';
    let id = '';
    let retry: number | undefined;
    let data: string[] = [];
    let completed = false;
    const emit = (): T | undefined => {
      // WHATWG: a blank line without data discards the event type; the last
      // event id and a pending retry are stream state and carry over.
      if (!data.length) {
        event = '';
        return undefined;
      }
      const value: Record<string, unknown> = { data: data.join('\\n') };
      if (event) value.event = event;
      if (id) value.id = id;
      if (retry !== undefined) value.retry = retry;
      event = '';
      data = [];
      retry = undefined;
      return JSON.parse(JSON.stringify(value));
    };
    const consume = (line: string): T | undefined => {
      if (line === '') return emit();
      if (line.startsWith(':')) return undefined;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? '' : line.slice(separator + 1);
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\\0')) id = value;
      else if (field === 'retry' && /^\\d+$/.test(value)) retry = Number(value);
      return undefined;
    };
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        buffered += decoder.decode(result.value, { stream: true });
        // A trailing CR may be the first half of a CRLF split across chunks.
        const heldCarriageReturn = buffered.endsWith('\\r');
        const lines = (heldCarriageReturn ? buffered.slice(0, -1) : buffered).split(/\\r\\n|\\r|\\n/);
        buffered = (lines.pop() || '') + (heldCarriageReturn ? '\\r' : '');
        for (const line of lines) {
          const value = consume(line);
          if (value !== undefined) yield value;
        }
      }
      buffered += decoder.decode();
      // At EOF a CR still ends its line; an unterminated line and an event
      // without its blank line are incomplete and are discarded.
      if (buffered.endsWith('\\r')) {
        const value = consume(buffered.slice(0, -1));
        if (value !== undefined) yield value;
      }
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
`)}
`;
}
