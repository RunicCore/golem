import {
  complianceMetadata,
  GENERATION_PROFILES,
  OPENAPI_VERSIONS,
  PROFILE_IDS,
  STATUS_LABELS,
  type CapabilityRecord,
  type CapabilityStatus,
  type CapabilitySurface,
  type ComplianceMetadata,
  type GenerationProfileId,
  type OpenApiVersion,
} from '../packages/golem-openapi/compliance/capabilities.js';

/**
 * These records remain useful to the internal compliance registry, but they
 * describe verification of a fixture corpus rather than a product feature.
 * Keep the exclusion here so every consumer-facing renderer applies the same
 * boundary without changing the authoritative registry.
 */
export const CONSUMER_EXCLUDED_CAPABILITIES = ['vendored-upstream-corpus'] as const;

export type SupportProjectionSurface =
  | 'Runtime behavior'
  | 'TypeScript types'
  | 'Generated metadata';

/** Opaque browser key; raw registry profile IDs stay build-time only. */
export type SupportProjectionProfileId = `profile-${number}`;

/**
 * The browser-facing support contract. Keep this deliberately smaller than
 * the compliance registry: evidence links and source paths are build-time
 * material, not consumer documentation.
 */
export interface SupportProjectionProfile {
  readonly id: SupportProjectionProfileId;
  readonly mobx: boolean;
  readonly validation: boolean;
  readonly label: string;
}

export interface SupportProjectionStatus {
  readonly id: CapabilityStatus;
  readonly label: string;
  readonly meaning: string;
}

export interface SupportProjectionRecord {
  readonly key: string;
  readonly title: string;
  readonly version: OpenApiVersion;
  readonly profile: SupportProjectionProfileId;
  readonly surface: SupportProjectionSurface;
  readonly mobx: boolean;
  readonly validation: boolean;
  readonly status: CapabilityStatus;
  readonly statusLabel: string;
  readonly limitations: readonly string[];
}

export interface SupportProjection {
  readonly schemaVersion: 1;
  readonly versions: readonly OpenApiVersion[];
  readonly profiles: readonly SupportProjectionProfile[];
  readonly statuses: readonly SupportProjectionStatus[];
  readonly capabilities: readonly SupportProjectionRecord[];
}

function profileLabel(profile: GenerationProfileId): string {
  const settings = GENERATION_PROFILES[profile];
  return `MobX ${settings.mobx ? 'On' : 'Off'} · Validation ${settings.validation ? 'On' : 'Off'}`;
}

function surfaceLabel(surface: CapabilitySurface): SupportProjectionSurface {
  switch (surface) {
    case 'runtime': return 'Runtime behavior';
    case 'types-contracts': return 'TypeScript types';
    case 'metadata': return 'Generated metadata';
  }
}

function profileProjectionId(index: number): SupportProjectionProfileId {
  return `profile-${index + 1}`;
}

export function consumerCapabilityRecords(
  metadata: ComplianceMetadata,
): readonly CapabilityRecord[] {
  return metadata.capabilities.filter((record) =>
    !CONSUMER_EXCLUDED_CAPABILITIES.includes(record.capability as (typeof CONSUMER_EXCLUDED_CAPABILITIES)[number]));
}

/** Build the consumer-only view from the authoritative, validated registry. */
export function buildSupportProjection(source: ComplianceMetadata = complianceMetadata()): SupportProjection {
  const metadata = source;
  const statuses = (Object.entries(STATUS_LABELS) as [CapabilityStatus, string][]).map(([id, label]) => {
    const meaning = metadata.statuses[label];
    if (!meaning) throw new Error(`Missing public meaning for support status ${label}`);
    return { id, label, meaning };
  });

  return {
    schemaVersion: 1,
    versions: [...OPENAPI_VERSIONS],
    profiles: PROFILE_IDS.map((id, index) => ({
      id: profileProjectionId(index),
      ...GENERATION_PROFILES[id],
      label: profileLabel(id),
    })),
    statuses,
    capabilities: consumerCapabilityRecords(metadata).map((record, index) => {
      const profileIndex = PROFILE_IDS.indexOf(record.profile);
      if (profileIndex < 0) throw new Error(`Unknown generation profile: ${record.profile}`);
      const profile = GENERATION_PROFILES[record.profile];
      return {
        // A stable opaque key is sufficient for DOM reconciliation. The raw
        // capability identifier stays in the server-side registry.
        key: `support-${index + 1}`,
        title: record.title,
        version: record.version,
        profile: profileProjectionId(profileIndex),
        surface: surfaceLabel(record.surface),
        mobx: profile.mobx,
        validation: profile.validation,
        status: record.status,
        statusLabel: STATUS_LABELS[record.status],
        limitations: [...record.limitations],
      };
    }),
  };
}
