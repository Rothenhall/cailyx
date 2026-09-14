/**
 * Types for the Backlinks module (DataForSEO Backlinks API).
 *
 * @module backlinks.types
 */

export type BacklinksStatus = 'pending' | 'completed' | 'partial' | 'failed';

export interface BacklinkSampleDto {
  urlFrom: string;
  urlTo: string;
  anchor: string | null;
  dofollow: boolean;
  rank: number | null;
  domainFromRank: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  itemType: string | null;
}

export interface BacklinksSummaryDto {
  id: string;
  projectId: string;
  target: string;
  status: BacklinksStatus;
  error: string | null;
  costUsd: number;

  rank: number | null;
  backlinks: number | null;
  backlinksSpamScore: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  referringPages: number | null;
  referringIps: number | null;
  referringSubnets: number | null;
  brokenBacklinks: number | null;
  brokenPages: number | null;
  firstSeen: string | null;
  lostDate: string | null;

  referringLinksTld: Record<string, number> | null;
  referringLinksTypes: Record<string, number> | null;
  referringLinksAttributes: Record<string, number> | null;
  referringLinksPlatformTypes: Record<string, number> | null;
  referringLinksCountries: Record<string, number> | null;

  topBacklinks: BacklinkSampleDto[];

  createdAt: string;
}
