import { APPROVAL_UI_HTML, APPROVAL_UI_URI } from './approval-app.mjs';
import {
  DEFAULT_APPROVAL_DURATION_SECONDS,
  MAX_APPROVAL_DURATION_SECONDS,
  MIN_APPROVAL_DURATION_SECONDS,
} from './approval-policy.mjs';

const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const UUID_PATTERN = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';

function approvalOutputSchema() {
  return {
    type: 'object',
    properties: {
      wall_time_seconds: { type: 'number' },
      output: { type: 'string' },
      kind: { type: 'string' },
      classification: { type: 'string' },
      approval_required: { type: 'boolean' },
      approval_id: { type: ['string', 'null'] },
      operation_id: { type: ['string', 'null'] },
      state: { type: ['string', 'null'] },
      owner: { type: 'boolean' },
      queued: { type: 'boolean' },
      scope_id: { type: ['string', 'null'] },
      tool_name: { type: ['string', 'null'] },
      action_summary: { type: ['string', 'null'] },
      intent_sha256: { type: ['string', 'null'] },
      created_at: { type: ['string', 'null'] },
      card_bound_at: { type: ['string', 'null'] },
      card_expires_at: { type: ['string', 'null'] },
      pending_expires_at: { type: ['string', 'null'] },
      terminal_reason: { type: ['string', 'null'] },
      default_duration_seconds: { type: 'integer' },
      requested_duration_seconds: { type: ['integer', 'null'] },
      grant_scope: { type: ['string', 'null'] },
      grant_effect: { type: ['string', 'null'] },
      grant_active: { type: 'boolean' },
      grant_state: { type: ['string', 'null'] },
      grant_approval_id: { type: ['string', 'null'] },
      grant_granted_at: { type: ['string', 'null'] },
      grant_expires_at: { type: ['string', 'null'] },
      grant_remaining_seconds: { type: 'integer' },
      usable: { type: 'boolean' },
      action_state: { type: ['string', 'null'] },
      action_failed: { type: 'boolean' },
      result_unavailable: { type: 'boolean' },
      bmg_classification: { type: ['string', 'null'] },
      gpt_safety_review_indicated: { type: 'boolean' },
      retry_recommended: { type: 'boolean' },
    },
    required: ['wall_time_seconds', 'output'],
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: false,
  };
}

export function approvalRouterTools() {
  return [
    {
      name: 'bmg_unlock',
      description: [
        'Exchange a six-digit code supplied explicitly by the user from their phone authenticator for a BMG full-access timed grant.',
        'Use ONLY when the user explicitly asks to use BMG and supplies the current code; CCM is the default for ordinary work.',
        'Works while local approval mode is totp or either. In either mode, an approval card is an alternative; only one authorization route is needed. The returned approval_id grants access to all public BMG browser tools.',
        'The authenticator generates a new code every 30 seconds; BMG accepts codes from approximately the last five minutes. A successfully redeemed code cannot be reused. Default grant duration is 21600 seconds (6 hours).',
        'Never fetch TOTP secrets or generate codes yourself, and never include the code in logs.',
      ].join('\n\n'),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: 'forbidden' },
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', pattern: '^[0-9]{6}$', description: 'Current six-digit user-provided authenticator code.' },
          duration_seconds: {
            type: 'integer',
            minimum: MIN_APPROVAL_DURATION_SECONDS,
            maximum: MAX_APPROVAL_DURATION_SECONDS,
            default: DEFAULT_APPROVAL_DURATION_SECONDS,
          },
        },
        required: ['code'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    },
    {
      name: 'approval_status',
      description: [
        'Inspect one BMG approval_id that you already possess.',
        'This is a point lookup only; it never lists or discovers other approval IDs.',
      ].join('\n\n'),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: 'forbidden' },
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: {
            type: 'string',
            format: 'uuid',
            pattern: UUID_PATTERN,
          },
        },
        required: ['approval_id'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      outputSchema: approvalOutputSchema(),
    },
    {
      name: 'get_approval_status',
      description: 'App-only authenticated read of this BMG approval card. Never dispatches an action or grants access.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: 'forbidden' },
      _meta: {
        ui: { visibility: ['app'] },
        'openai/widgetAccessible': true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', format: 'uuid', pattern: UUID_PATTERN },
          approval_nonce: { type: 'string', minLength: 20 },
        },
        required: ['approval_id', 'approval_nonce'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      outputSchema: approvalOutputSchema(),
    },
    {
      name: 'request_approval',
      description: [
        'Render the BMG approval card for one already-frozen pending action.',
        'Pass the approval_id plus an optional duration_seconds.',
        'If duration_seconds is omitted, the requested duration is 21600 seconds (6 hours).',
        'Common values: 60=1 minute, 300=5 minutes, 1800=30 minutes, 3600=1 hour, 21600=6 hours, 86400=1 day, 604800=7 days.',
        'The duration is frozen when the approval card is bound and starts only when the user approves.',
      ].join('\n\n'),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: 'forbidden' },
      _meta: {
        ui: { resourceUri: APPROVAL_UI_URI, visibility: ['model', 'app'] },
        'ui/resourceUri': APPROVAL_UI_URI,
        'openai/outputTemplate': APPROVAL_UI_URI,
        'openai/widgetAccessible': true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: {
            type: 'string',
            format: 'uuid',
            pattern: UUID_PATTERN,
          },
          duration_seconds: {
            type: 'integer',
            minimum: MIN_APPROVAL_DURATION_SECONDS,
            maximum: MAX_APPROVAL_DURATION_SECONDS,
            default: DEFAULT_APPROVAL_DURATION_SECONDS,
          },
        },
        required: ['approval_id'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      outputSchema: approvalOutputSchema(),
    },
    {
      name: 'resolve_pending_action',
      description: 'App-only resolver for one frozen BMG action.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      execution: { taskSupport: 'forbidden' },
      _meta: {
        ui: { visibility: ['app'] },
        'openai/widgetAccessible': true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', format: 'uuid', pattern: UUID_PATTERN },
          approval_nonce: { type: 'string', minLength: 20 },
          decision: { type: 'string', enum: ['approve', 'deny'] },
        },
        required: ['approval_id', 'approval_nonce', 'decision'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      outputSchema: approvalOutputSchema(),
    },
  ];
}

export function approvalResource() {
  return {
    uri: APPROVAL_UI_URI,
    name: 'bmg-approval-ui',
    title: 'BMG approval',
    description: 'Approval card for one frozen BMG action.',
    mimeType: RESOURCE_MIME_TYPE,
  };
}

export function localApprovalResource(payload) {
  if (payload?.method === 'resources/list') {
    return { result: { resources: [approvalResource()] } };
  }
  if (payload?.method === 'resources/templates/list') {
    return { result: { resourceTemplates: [] } };
  }
  if (payload?.method === 'resources/read' && payload?.params?.uri === APPROVAL_UI_URI) {
    return {
      result: {
        contents: [{
          uri: APPROVAL_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: APPROVAL_UI_HTML,
          _meta: { ui: { prefersBorder: true } },
        }],
      },
    };
  }
  if (payload?.method === 'resources/read') {
    return { error: { code: -32002, message: 'Resource not found.' } };
  }
  return null;
}

export { APPROVAL_UI_URI };
