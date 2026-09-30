import { IssueCode, IssueRepresentation, IssueSource, LibError, LibErrorKind, type IssuePath } from './errors.js';

/** The model path of the field being converted; conversion pushes and pops it. Internal. */
export const activeConversionPath: (string | number)[] = [];

export function conversionError(
  kind: LibErrorKind.Serialization | LibErrorKind.Deserialization,
  message: string,
  path: IssuePath = activeConversionPath,
  cause?: unknown,
  causedByInput = false,
): LibError {
  return new LibError(kind, message, [{
    code: kind === LibErrorKind.Serialization ? IssueCode.Serialization : IssueCode.Deserialization,
    message, path, source: IssueSource.Serde,
    representation: kind === LibErrorKind.Serialization ? IssueRepresentation.Model : IssueRepresentation.Wire,
  }], { ...(cause === undefined ? {} : { cause }), causedByInput });
}
