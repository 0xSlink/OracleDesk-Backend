import fs from 'fs';
import path from 'path';

/**
 * Single source of truth for the JSON Schemas served at `/api/v1/schemas/*`
 * and committed at `src/schemas/*.schema.json`.
 *
 * Lives inside `src/` (not `scripts/`) so the route module and the CLI can
 * both import from the same path without reaching outside the TypeScript
 * `rootDir`. The committed files use the canonical base URL and the route
 * rewrites `$id` from `PUBLIC_API_BASE_URL` on each request.
 */

const SCHEMAS_DIR = path.join(__dirname);
const CANONICAL_BASE = 'https://api.oracledesk.io';

export const TRACE_V1_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CANONICAL_BASE}/api/v1/schemas/trace/v1.json`,
  title: 'OracleDesk Reasoning Trace v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'kind',
    'traceId',
    'agentType',
    'decisionType',
    'action',
    'market',
    'probabilityEstimate',
    'marketProbability',
    'edge',
    'confidenceInterval',
    'sourcesUsed',
    'betFraction',
    'betSizeUsdc',
    'hedgeConditions',
    'agentWallet',
    'createdAt',
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: 'oracledesk.trace' },
    traceId: { type: 'string', format: 'uuid' },
    agentType: { type: 'string', enum: ['MARKET_MAKER', 'TRADER'] },
    decisionType: { type: 'string', minLength: 1, maxLength: 64 },
    action: { type: 'string', minLength: 1, maxLength: 64 },
    market: {
      type: 'object',
      additionalProperties: false,
      required: ['backendId', 'onChainId'],
      properties: {
        backendId: { type: 'string', format: 'uuid' },
        onChainId: { type: ['string', 'null'], pattern: '^\\d+$' },
      },
    },
    probabilityEstimate: { type: 'number', minimum: 0, maximum: 1 },
    marketProbability: { type: 'number', minimum: 0, maximum: 1 },
    edge: { type: 'number', minimum: -1, maximum: 1 },
    confidenceInterval: {
      type: 'object',
      additionalProperties: false,
      required: ['lower', 'upper'],
      properties: {
        lower: { type: 'number' },
        upper: { type: 'number' },
      },
    },
    sourcesUsed: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'weight', 'signal', 'rawValue'],
        properties: {
          source: { type: 'string' },
          weight: { type: 'number', minimum: 0, maximum: 1 },
          signal: { type: 'string' },
          rawValue: { type: ['number', 'null'] },
        },
      },
    },
    betFraction: { type: ['number', 'null'] },
    betSizeUsdc: { type: ['number', 'null'] },
    hedgeConditions: {
      type: 'array',
      items: { type: 'string', maxLength: 500 },
    },
    agentWallet: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

/**
 * Shared question-document properties. Both v1 and v2 pin the same core
 * shape; v2 additionally carries a `resolution` block (#74), and either
 * version may carry an optional `priceResolution` block (#90).
 */
const QUESTION_COMMON_PROPERTIES = {
  question: { type: 'string', minLength: 1 },
  category: {
    type: 'string',
    enum: [
      'FED',
      'ECB',
      'MACRO',
      'GEOPOLITICAL',
      'ELECTION',
      'POLITICS',
      'CRYPTO',
      'SPORTS',
      'ENTERTAINMENT',
    ],
  },
  contractCategory: {
    type: 'string',
    enum: ['Macro', 'Geopolitics', 'Crypto', 'Sports', 'Culture', 'Other'],
  },
  closeTime: { type: 'integer' },
  resolutionSource: { type: ['string', 'null'] },
  resolutionHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  backendMarketId: { type: 'string', format: 'uuid' },
  priceResolution: {
    type: 'object',
    additionalProperties: true,
    required: ['kind', 'reflector', 'asset', 'assetKind', 'threshold', 'direction', 'maxStaleness'],
    properties: {
      kind: { const: 'price' },
      reflector: { type: 'string' },
      asset: { type: 'string' },
      assetKind: { type: 'string' },
      threshold: { type: ['number', 'string'] },
      direction: { type: 'string' },
      maxStaleness: { type: 'integer', minimum: 0 },
    },
  },
} as const;

const QUESTION_COMMON_REQUIRED = [
  'question',
  'category',
  'contractCategory',
  'closeTime',
  'resolutionSource',
  'resolutionHash',
  'backendMarketId',
] as const;

export const QUESTION_V1_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CANONICAL_BASE}/api/v1/schemas/question/v1.json`,
  title: 'OracleDesk Question Document v1',
  type: 'object',
  additionalProperties: false,
  required: ['version', ...QUESTION_COMMON_REQUIRED],
  properties: {
    version: { const: 1 },
    ...QUESTION_COMMON_PROPERTIES,
  },
};

export const QUESTION_V2_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CANONICAL_BASE}/api/v1/schemas/question/v2.json`,
  title: 'OracleDesk Question Document v2',
  type: 'object',
  additionalProperties: false,
  required: ['version', ...QUESTION_COMMON_REQUIRED, 'resolution'],
  properties: {
    version: { const: 2 },
    ...QUESTION_COMMON_PROPERTIES,
    resolution: { type: 'object', additionalProperties: true },
  },
};

export interface SchemaTarget {
  file: string;
  path: string;
  schema: Record<string, unknown>;
  title: string;
}

export const SCHEMA_TARGETS: SchemaTarget[] = [
  { file: 'trace.schema.json', path: 'trace/v1.json', schema: TRACE_V1_SCHEMA, title: 'Reasoning Trace v1' },
  { file: 'question.schema.json', path: 'question/v2.json', schema: QUESTION_V2_SCHEMA, title: 'Question v2' },
  { file: 'question-v1.schema.json', path: 'question/v1.json', schema: QUESTION_V1_SCHEMA, title: 'Question v1' },
];

export function jsonSchemaFor(target: SchemaTarget, baseUrl: string): Record<string, unknown> {
  return {
    ...target.schema,
    $id: `${baseUrl.replace(/\/$/, '')}/api/v1/schemas/${target.path}`,
  };
}

/**
 * Writes or checks the committed JSON Schema files. `check` mode returns
 * `false` on any drift (prints which files are stale); `write` mode
 * overwrites them. The committed files always use the canonical base URL.
 */
export function generateSchemas(opts: { check?: boolean } = {}): boolean {
  let matches = true;

  for (const target of SCHEMA_TARGETS) {
    const dest = path.join(SCHEMAS_DIR, target.file);
    const content = JSON.stringify(target.schema, null, 2) + '\n';

    if (opts.check) {
      if (!fs.existsSync(dest)) {
        console.error(`Missing schema file: ${target.file}`);
        matches = false;
        continue;
      }
      const existing = fs.readFileSync(dest, 'utf8');
      if (existing !== content) {
        console.error(`Schema file out of date: ${target.file}`);
        matches = false;
      }
    } else {
      fs.writeFileSync(dest, content, 'utf8');
      console.log(`Generated ${dest}`);
    }
  }

  return matches;
}
