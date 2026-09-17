/**
 * Types for the Content Generation module — P09 (platform_improvement_plan.md
 * §13.7, §13.9). Durable, resumable generation on top of the existing
 * GenerationJob ledger and the shared BullMQ pipeline queue (jobs module).
 *
 * @module content-generation.types
 */

export interface GenerationTopicInput {
  targetKeyword: string;
  blogTopic?: string;
  adAngle?: string;
  searchVolume?: number | null;
}

export interface GenerationJobDto {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  assetType: string;
  contentAssetId: string | null;
  briefId: string | null;
  briefVersion: number | null;
  writingStyleProfileId: string | null;
  writingStyleVersion: number | null;
  writingStyleFingerprint: string | null;
  businessProfileVersion: number | null;
  attempts: number;
  maxAttempts: number;
  revisionId: string | null;
  error: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}
