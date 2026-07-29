export const METIS_RELEASE_POLICY = Object.freeze({
  schemaVersion: 1,
  appId: 'com.metis.workbench',
  productName: 'Metis Research Workbench',
  nsisGuid: 'd8750f35-9d24-4ca0-ae31-470c38e5d9d1',
  msiUpgradeCode: '8f1d3af6-43a8-4a4a-9b6c-38ac99b5d342',
  userDataPolicy: Object.freeze({
    upgrade: 'preserve',
    standardUninstall: 'preserve',
    fullRemoval: 'explicit-user-action-only',
  }),
} as const);

export type ReleaseArtifactKind = 'nsis' | 'msi';

export interface ReleaseArtifactEvidence {
  readonly kind: ReleaseArtifactKind;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly authenticodeStatus: 'Valid';
  readonly signerSubject: string;
  readonly signerThumbprint: string;
  readonly timestampSubject: string;
}

export interface ReleaseProvenanceLink {
  readonly sourceManifestSha256: string;
  readonly distManifestSha256: string;
  readonly packageManifestSha256: string;
}
