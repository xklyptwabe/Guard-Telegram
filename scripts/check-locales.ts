import { en, ru } from '../src/i18n/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectKeys(value: unknown, prefix = ''): readonly string[] {
  if (!isRecord(value)) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) => collectKeys(nested, prefix ? `${prefix}.${key}` : key));
}

const ruKeys = new Set(collectKeys(ru));
const enKeys = new Set(collectKeys(en));
const missingFromEn = [...ruKeys].filter((key) => !enKeys.has(key));
const missingFromRu = [...enKeys].filter((key) => !ruKeys.has(key));

if (missingFromEn.length > 0 || missingFromRu.length > 0) {
  process.stderr.write(`Locale keys differ. Missing en: ${missingFromEn.join(', ')}. Missing ru: ${missingFromRu.join(', ')}.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Locale keys are synchronized.\n');
}
