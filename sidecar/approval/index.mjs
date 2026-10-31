import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ApprovalPolicyStore,
  DEFAULT_APPROVAL_DURATION_SECONDS,
  validateApprovalDurationSeconds,
} from './approval-policy.mjs';
import { PendingActionManager } from './pending-action-manager.mjs';
import { TimedGrantManager } from './timed-grant-manager.mjs';
import { ApprovalReceiptStore } from './approval-receipt-store.mjs';
import { BmgTotpManager } from './totp.mjs';
import { approvalRouterTools, approvalResource, APPROVAL_UI_URI } from './approval-routing.mjs';

const APPROVAL_TOOL_NAMES = new Set(approvalRouterTools().map((tool) => tool.name));
const UUID_PATTERN = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
const GRANT_DESCRIPTION = 'Active BMG grant ID. Timed: omit to request approval. TOTP: obtain via bmg_unlock using a user-provided code. Never invent IDs.';
const GRANT_GUIDANCE = 'If BMG requires approval, call request_approval with the returned ID. TOTP uses bmg_unlock with a user code. The card executes the frozen action once.';

function grantFields(grant) {
  const active = grant?.grant_state === 'active';
  return {
    grant_active: active,
    grant_state: grant?.grant_state || null,
    grant_approval_id: grant?.approval_id || null,
    grant_granted_at: grant?.granted_at || null,
    grant_expires_at: grant?.expires_at || null,
    grant_remaining_seconds: grant?.remaining_seconds || 0,
    usable: active,
  };
}

function status(value) {
  return { wall_time_seconds: 0, kind: 'approval', ...value };
}

function result(value, { isError = false, meta = null } = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

function readableError(error) {
  return String(error?.message || error);
}

function actionText(toolResult) {
  return (toolResult?.content || [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

export function isApprovalTool(name) {
  return APPROVAL_TOOL_NAMES.has(name);
}

export function approvalTools() {
  return approvalRouterTools();
}

export function approvalUiResource() {
  return approvalResource();
}

export function isApprovalUiResource(uri) {
  return uri === APPROVAL_UI_URI;
}

export function addApprovalToTools(tools) {
  const existing = new Set(tools.map((tool) => tool.name));
  const routed = tools.map((tool) => {
    const schema = structuredClone(tool.inputSchema || { type: 'object', properties: {} });
    schema.type = 'object';
    schema.properties = {
      ...(schema.properties || {}),
      approval_id: {
        type: 'string', format: 'uuid', pattern: UUID_PATTERN,
        description: GRANT_DESCRIPTION,
      },
    };
    return {
      ...tool,
      inputSchema: schema,
      description: String(tool.description || '') + '\n\n' + GRANT_GUIDANCE,
    };
  });
  return [
    ...routed,
    ...approvalRouterTools().filter((tool) => !existing.has(tool.name)),
  ];
}

export function withoutApprovalId(args) {
  const cleaned = { ...(args || {}) };
  delete cleaned.approval_id;
  return cleaned;
}

export class BmgApprovalGate {
  constructor({ rootDir, logDir, logger = null, totpManager = null, now = () => Date.now() }) {
    this.policyStore = new ApprovalPolicyStore({ root: rootDir, logger });
    this.receipts = new ApprovalReceiptStore({
      stateFile: path.join(logDir, 'approval-receipts.json'), now,
    });
    this.pending = new PendingActionManager({
      now, onTerminal: (request, state) => this.receipts.save(request, state),
    });
    this.grants = new TimedGrantManager({ now });
    this.totp = totpManager || new BmgTotpManager({ root: rootDir, now });
    this.policy = this.policyStore.current();
  }

  currentPolicy() {
    const refreshed = this.policyStore.refresh();
    if (refreshed.changed) {
      this.grants.clearAll('policy_changed');
      this.pending.clearPendingAll('policy_changed');
    }
    this.policy = refreshed.policy;
    return this.policy;
  }

  snapshot() {
    const policy = this.currentPolicy();
    return {
      mode: policy.mode,
      policy_revision: policy.revision,
      default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
      ...this.pending.snapshot(),
      ...this.grants.snapshot(),
    };
  }

  inspection(approvalId) {
    const request = this.pending.lookup(approvalId);
    const grant = this.grants.inspect(approvalId);
    const active = grant?.grant_state === 'active';
    return status({
      approval_id: approvalId || null,
      operation_id: request?.operation_id || grant?.operation_id || null,
      approval_required: request?.state === 'pending',
      state: request?.state || null,
      classification: active ? 'approval_id_active' : (grant?.grant_state ? 'approval_id_' + grant.grant_state : 'approval_id_unknown'),
      ...request,
      ...grantFields(grant),
      requested_duration_seconds: grant?.requested_duration_seconds || request?.requested_duration_seconds || null,
      grant_scope: 'full_bmg',
      grant_effect: 'all_public_bmg_browser_tools',
      output: active
        ? 'Active BMG grant. Reuse this approval_id on subsequent browser-tool calls.'
        : 'This approval_id is not active. Request a new BMG approval or user-provided phone code.',
    });
  }

  authorize(name, args) {
    const policy = this.currentPolicy();
    const toolArguments = withoutApprovalId(args);
    if (policy.mode === 'off') return { allowed: true, args: toolArguments };
    if (args?.approval_id) {
      if (!this.grants.active(args.approval_id)) {
        return { allowed: false, toolResult: result(this.inspection(args.approval_id), { isError: true }) };
      }
      return { allowed: true, args: toolArguments };
    }
    if (policy.mode === 'totp') {
      return { allowed: false, toolResult: result(status({
        classification: 'bmg_code_required',
        output: 'BMG requires an active approval_id. Ask the user for a six-digit phone authenticator code and call bmg_unlock.',
      }), { isError: true }) };
    }
    const pending = this.pending.ensurePending({
      scopeId: 'bmg-browser',
      toolName: name,
      toolArguments,
      summary: name + ' in the BMG browser workspace',
    });
    return { allowed: false, toolResult: result(status({
      classification: 'approval_required',
      ...pending.request,
      owner: true,
      queued: false,
      default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
      requested_duration_seconds: null,
      grant_scope: 'full_bmg',
      grant_effect: 'all_public_bmg_browser_tools',
      ...grantFields(null),
      action_state: null,
      action_failed: false,
      output: 'Approval required. Call request_approval with this approval_id and optional duration_seconds. The approval card will execute the frozen action once; do not rerun it.',
    })) };
  }

  async handleLocal(name, args, hostSession, executeFrozen) {
    this.currentPolicy();
    if (name === 'approval_status') {
      return result(this.inspection(args.approval_id));
    }
    if (name === 'bmg_unlock') {
      if (this.policy.mode !== 'totp') {
        return result(status({ classification: 'bmg_unlock_unavailable', output: 'BMG is not in totp mode.' }), { isError: true });
      }
      try {
        const duration = validateApprovalDurationSeconds(args.duration_seconds);
        if (!this.totp.verify(args.code)) {
          return result(status({ classification: 'bmg_code_invalid', output: 'Code invalid, reused, or temporarily rate-limited.' }), { isError: true });
        }
        const approvalId = randomUUID();
        const grant = this.grants.grant({
          approvalId, requestedDurationSeconds: duration,
          operationId: 'totp-' + randomUUID(), policyRevision: this.policy.revision,
        });
        return result(status({
          classification: 'bmg_unlocked', approval_id: approvalId,
          grant_scope: 'full_bmg', grant_effect: 'all_public_bmg_browser_tools',
          ...grantFields(grant),
          output: 'BMG unlocked. Pass this approval_id on BMG browser-tool calls.',
        }));
      } catch {
        return result(status({ classification: 'bmg_unlock_error', output: 'BMG phone-code verification failed.' }), { isError: true });
      }
    }
    if (name === 'get_approval_status') {
      try {
        const state = this.pending.readAppStatus(
          args.approval_id, args.approval_nonce, hostSession, this.receipts,
        );
        return result(status({
          classification: 'approval_card_state',
          ...state, ...grantFields(this.grants.inspect(args.approval_id)),
          action_state: state.state === 'pending' ? null : state.state,
          output: state.result_unavailable ? 'Archived decision only; no access or action restored.' : 'Current approval state verified.',
        }));
      } catch (error) {
        return result(status({ classification: 'approval_card_unavailable', approval_id: args.approval_id, output: readableError(error) }), { isError: true });
      }
    }
    if (name === 'request_approval') {
      try {
        if (this.policy.mode !== 'timed') throw new Error('BMG is not in timed approval mode.');
        const duration = validateApprovalDurationSeconds(args.duration_seconds);
        const prepared = this.pending.prepareAppApproval(args.approval_id, {
          hostSession, requestedDurationSeconds: duration,
        });
        const value = status({
          classification: 'approval_pending_user',
          ...prepared.request,
          owner: true, queued: false,
          default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
          grant_scope: 'full_bmg', grant_effect: 'all_public_bmg_browser_tools',
          ...grantFields(null),
          action_state: null, action_failed: false,
          output: 'Waiting for the user to approve or deny this timed BMG access request.',
        });
        return {
          ...result(value, { meta: { source: 'bmg.approval', approval_nonce: prepared.approvalNonce } }),
          content: [{ type: 'text', text: 'BMG prepared a frozen action for user approval. Approval ID: ' +
            value.approval_id + '. Tool: ' + value.tool_name + '. Duration: ' +
            duration + ' seconds. The attached approval card is the only path to approve this request.' }],
        };
      } catch (error) {
        return result(status({
          classification: 'approval_error', approval_id: args.approval_id || null,
          output: readableError(error),
        }), { isError: true });
      }
    }
    if (name !== 'resolve_pending_action') return null;
    try {
      if (args.decision === 'deny') {
        const denied = this.pending.deny(args.approval_id, args.approval_nonce, hostSession);
        return result(status({
          classification: 'approval_denied', ...denied,
          ...grantFields(null), action_state: 'denied', action_failed: false,
          output: 'The user denied the frozen BMG action. It was not dispatched.',
        }));
      }
      if (args.decision !== 'approve' || this.policy.mode !== 'timed') {
        throw new Error('Approval decision or mode is invalid.');
      }
      const claimed = this.pending.claim(args.approval_id, args.approval_nonce, hostSession);
      const grant = this.grants.grant({
        approvalId: args.approval_id,
        requestedDurationSeconds: claimed.requestedDurationSeconds,
        operationId: claimed.request.operation_id,
        policyRevision: this.policy.revision,
      });
      const base = status({
        classification: 'approval_resolved',
        ...claimed.request,
        grant_scope: 'full_bmg', grant_effect: 'all_public_bmg_browser_tools',
        ...grantFields(grant),
        requested_duration_seconds: claimed.requestedDurationSeconds,
      });
      try {
        const ownerResult = await executeFrozen(
          claimed.action.toolName, claimed.action.toolArguments,
        );
        const failed = ownerResult?.isError === true;
        const consumed = this.pending.markConsumed(args.approval_id, { actionFailed: failed });
        return result({
          ...base, ...consumed, action_state: 'consumed', action_failed: failed,
          output: (actionText(ownerResult) || 'Approved owner action completed.') +
            ' The timed BMG grant is active; reuse this approval_id for later calls.',
        });
      } catch (error) {
        const state = error?.bmgPreDispatch === true ? 'approved_retryable' : 'execution_unknown';
        const failed = state === 'approved_retryable'
          ? this.pending.markRetryable(args.approval_id)
          : this.pending.markUnknown(args.approval_id);
        return result({
          ...base, ...failed, action_state: state, action_failed: false,
          output: readableError(error) +
            (state === 'approved_retryable'
              ? ' Owner action was not dispatched.'
              : ' Owner action outcome is unknown and will not be automatically retried.') +
            ' The BMG grant remains active.',
        });
      }
    } catch (error) {
      return result(status({
        classification: 'approval_error', approval_id: args.approval_id || null,
        output: readableError(error),
      }), { isError: true });
    }
  }
}
