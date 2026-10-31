import type * as ts from '@exprtlabs/golem/internal/ts';
import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import { displayPath } from '@exprtlabs/golem/internal/generator-support';

export { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';

/** Stable provider diagnostic identifiers consumed by the shared CLI. */
export enum TsToOpenApiDiagnosticCode {
  NoExportedControllers = 'NEST1001',
  NoControllerSources = 'NEST1002',
  UnsupportedNestParameter = 'NEST1101',
  UnrepresentableNestParameter = 'NEST1102',
  UnknownParameterKeys = 'NEST1105',
  NonPrimitiveParameter = 'NEST1106',
  NonPortableParameter = 'NEST1107',
  LossyQueryFlatten = 'NEST1108',
  UnsupportedRouteDecorator = 'NEST1201',
  VersionWithoutUriRouting = 'NEST1202',
  UnsupportedVersioningType = 'NEST1203',
  InvalidVersioningOptions = 'NEST1204',
  UnsupportedVersioningMode = 'NEST1205',
  HostBasedRouting = 'NEST1206',
  UnsupportedParameterLocation = 'NEST1301',
  MissingParameterName = 'NEST1302',
  MissingPathParameter = 'NEST1303',
  UnsupportedHttpMethod = 'NEST1304',
  DuplicateOperationId = 'NEST1305',
  DuplicateRoute = 'NEST1306',
  ExtraPathParameter = 'NEST1307',
  DuplicateResponseStatus = 'NEST1308',
  InvalidResponseStatus = 'NEST1309',
  PrimitiveResponseMetadata = 'NEST1310',
  InvalidInfo = 'NEST1401',
  UnsupportedOpenApiVersion = 'NEST1402',
  InvalidServer = 'NEST1403',
  InvalidSecurityScheme = 'NEST1404',
  InvalidSecurityRequirement = 'NEST1405',
  MissingSchemaResolver = 'NEST1501',
  NonportableSchema = 'NEST1502',
  ConflictingSchemaMetadata = 'NEST1503',
  UnsupportedSchemaMetadata = 'NEST1504',
  UnresolvedSchemaReference = 'NEST1505',
  ConflictingResponseStatus = 'NEST1311',
  DuplicateParameter = 'NEST1312',
  DuplicateControllerName = 'NEST1313',
  UnsupportedRoutePath = 'NEST1207',
  UnsupportedRouteExpression = 'RUNT2101',
  RouteResultTooLarge = 'RUNT2106',
}

export interface TsToOpenApiDiagnostic {
  readonly severity: GolemDiagnosticSeverity;
  readonly code: TsToOpenApiDiagnosticCode;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export class TsToOpenApiError extends Error {
  public readonly diagnostics: readonly TsToOpenApiDiagnostic[];

  public constructor(diagnostics: readonly TsToOpenApiDiagnostic[] | TsToOpenApiDiagnostic) {
    const entries = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
    super(entries.map(formatDiagnostic).join('\n'));
    this.name = 'TsToOpenApiError';
    this.diagnostics = entries;
  }
}

export function diagnostic(
  sourceFile: ts.SourceFile | undefined,
  node: ts.Node | undefined,
  code: TsToOpenApiDiagnosticCode,
  message: string,
  severity: GolemDiagnosticSeverity = GolemDiagnosticSeverity.Error,
): TsToOpenApiDiagnostic {
  if (!sourceFile || !node) return { severity, code, message };
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    severity,
    code,
    message,
    file: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function formatDiagnostic(value: TsToOpenApiDiagnostic): string {
  const location = value.file
    ? `${displayPath(value.file)}${value.line === undefined ? '' : `:${value.line}:${value.column ?? 1}`}: `
    : '';
  return `${location}${value.severity.toUpperCase()} ${value.code}: ${value.message}`;
}
