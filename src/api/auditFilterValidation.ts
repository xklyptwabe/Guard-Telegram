import { z } from 'zod';

export const AUDIT_API_MAX_LIMIT = 100;

export const auditLimitSchema = z.number().int().min(1).max(AUDIT_API_MAX_LIMIT);

export const auditFilterDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
