import { z } from 'zod';

export const auditFilterDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
