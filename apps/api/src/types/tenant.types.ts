// apps/api/src/types/tenant.types.ts
export interface TenantTestResult {
  lineOk: boolean;
  hfmOk: boolean;
  walletOk: boolean;
  message: string;
}

// Fully resolved, decrypted, ready to use. Passed as `ctx` into services.
export interface TenantConfig {
  id: number;
  webhookId: string;
  label: string;
  active: boolean;
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  lineBotUserId: string | null;
  lineBasicId: string | null;
  lineDisplayName: string | null;
  hfmApiKey: string;
  hfmApiBaseUrl: string;
  targetWallet: number;
  whitelistEnabled: boolean;
  whitelistUids: string[];
  lastTestedAt: string | null;
  lastTestResult: TenantTestResult | null;
}

// Row shape as stored, secrets still encrypted. Repository layer only.
export interface TenantRow {
  id: number;
  webhookId: string;
  label: string;
  active: number;
  lineChannelAccessTokenEnc: string;
  lineChannelSecretEnc: string;
  lineBotUserId: string | null;
  lineBasicId: string | null;
  lineDisplayName: string | null;
  hfmApiKeyEnc: string;
  hfmApiBaseUrl: string;
  targetWallet: number;
  whitelistEnabled: number;
  keyVersion: number;
  lastTestedAt: string | null;
  lastTestResult: string | null;
}

// Plaintext input used by the UI and the one-time bootstrap seed.
export interface TenantInput {
  label: string;
  active: boolean;
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  hfmApiKey: string;
  hfmApiBaseUrl: string;
  targetWallet: number;
  whitelistEnabled: boolean;
}
