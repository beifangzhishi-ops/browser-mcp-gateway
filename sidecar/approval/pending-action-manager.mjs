import crypto from 'node:crypto';

export const DEFAULT_UNBOUND_APPROVAL_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_BOUND_APPROVAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_RETENTION_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_RETENTION_LIMIT = 1000;

function hashIntent(intent) {
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function secretMatches(value, expectedHash) {
  if (!expectedHash) return false;
  const actual = hashSecret(value);
  return actual.length === expectedHash.length && crypto.timingSafeEqual(actual, expectedHash);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

export class PendingActionManager {
  constructor({
    unboundTtlMs = DEFAULT_UNBOUND_APPROVAL_TTL_MS,
    boundTtlMs = DEFAULT_BOUND_APPROVAL_TTL_MS,
    terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
    terminalRetentionLimit = DEFAULT_TERMINAL_RETENTION_LIMIT,
    now = () => Date.now(),
    audit = null,
    onTerminal = null,
  } = {}) {
    this.unboundTtlMs = Number.isFinite(Number(unboundTtlMs)) && Number(unboundTtlMs) > 0
      ? Number(unboundTtlMs)
      : DEFAULT_UNBOUND_APPROVAL_TTL_MS;
    this.boundTtlMs = Number.isFinite(Number(boundTtlMs)) && Number(boundTtlMs) > 0
      ? Number(boundTtlMs)
      : DEFAULT_BOUND_APPROVAL_TTL_MS;
    this.terminalRetentionMs = Number.isFinite(Number(terminalRetentionMs)) && Number(terminalRetentionMs) > 0
      ? Number(terminalRetentionMs)
      : DEFAULT_TERMINAL_RETENTION_MS;
    this.terminalRetentionLimit = Number.isInteger(Number(terminalRetentionLimit)) && Number(terminalRetentionLimit) > 0
      ? Number(terminalRetentionLimit)
      : DEFAULT_TERMINAL_RETENTION_LIMIT;
    this.now = now;
    this.audit = audit;
    this.onTerminal = onTerminal;
    this.requests = new Map();
  }

  emit(event, request, extra = {}) {
    if (!this.audit) return;
    this.audit({
      event,
      approval_id: request?.approvalId || null,
      operation_id: request?.operationId || null,
      state: request?.state || null,
      intent_sha256: request?.intentHash || null,
      created_at: iso(request?.createdAt),
      card_bound_at: iso(request?.cardBoundAt),
      card_expires_at: iso(request?.cardExpiresAt),
      terminal_reason: request?.terminalReason || null,
      ...extra,
    });
  }

  recordTerminal(request, { actionFailed = false } = {}) {
    try {
      this.onTerminal?.(request, { state: request.state, actionFailed });
    } catch (error) {
      this.audit?.({
        event: 'approval_receipt_save_failed',
        approval_id: request.approvalId,
        error: String(error?.message || error),
      });
    }
  }

  pendingDeadline(request) {
    return request?.cardBoundAt != null
      ? request.cardExpiresAt
      : request?.unboundExpiresAt;
  }

  terminalAt(request) {
    return request?.consumedAt ??
      request?.unknownAt ??
      request?.retryableAt ??
      request?.respondedAt ??
      request?.expiredAt ??
      request?.supersededAt ??
      null;
  }

  prune() {
    const now = this.now();
    for (const request of this.requests.values()) {
      const pendingDeadline = this.pendingDeadline(request);
      if (
        request.state === 'pending' &&
        pendingDeadline != null &&
        pendingDeadline <= now
      ) {
        request.state = 'expired';
        request.expiredAt = now;
        request.terminalReason = request.cardBoundAt != null
          ? 'card_timeout'
          : 'unbound_timeout';
        this.emit('expired', request);
        this.recordTerminal(request);
        continue;
      }
      const terminalAt = this.terminalAt(request);
      if (
        request.state !== 'pending' &&
        request.state !== 'dispatching' &&
        terminalAt != null &&
        terminalAt + this.terminalRetentionMs <= now
      ) {
        this.requests.delete(request.approvalId);
      }
    }
    const terminal = [...this.requests.values()]
      .filter((request) => request.state !== 'pending' && request.state !== 'dispatching')
      .map((request) => ({ request, terminalAt: this.terminalAt(request) }))
      .filter((item) => item.terminalAt != null)
      .sort((a, b) => a.terminalAt - b.terminalAt);
    const excess = terminal.length - this.terminalRetentionLimit;
    for (let index = 0; index < excess; index += 1) {
      this.requests.delete(terminal[index].request.approvalId);
    }
  }

  publicRequest(request) {
    return {
      approval_required: request.state === 'pending',
      approval_id: request.approvalId,
      operation_id: request.operationId,
      state: request.state,
      scope_id: request.action.scopeId,
      tool_name: request.action.toolName,
      action_summary: request.action.summary,
      created_at: iso(request.createdAt),
      card_bound_at: iso(request.cardBoundAt),
      card_expires_at: iso(request.cardExpiresAt),
      pending_expires_at: request.state === 'pending'
        ? iso(this.pendingDeadline(request))
        : null,
      requested_duration_seconds: request.requestedDurationSeconds ?? null,
      intent_sha256: request.intentHash,
      terminal_reason: request.terminalReason || null,
      action_failed: request.actionFailed === true,
    };
  }

  ensurePending({
    scopeId,
    toolName,
    toolArguments,
    summary = '',
  }) {
    this.prune();
    if (typeof scopeId !== 'string' || !scopeId) throw new Error('scopeId is required.');
    if (typeof toolName !== 'string' || !toolName) throw new Error('toolName is required.');

    const action = {
      scopeId,
      toolName,
      toolArguments: structuredClone(toolArguments || {}),
      summary: String(summary || toolName),
    };
    const intent = {
      type: 'bmg_tool_call',
      scope_id: scopeId,
      tool_name: toolName,
      arguments: action.toolArguments,
    };
    const createdAt = this.now();
    const request = {
      approvalId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      state: 'pending',
      intentHash: hashIntent(intent),
      action,
      createdAt,
      unboundExpiresAt: createdAt + this.unboundTtlMs,
      cardBoundAt: null,
      cardExpiresAt: null,
      requestedDurationSeconds: null,
      approvalNonceHash: null,
      hostSession: null,
      terminalReason: null,
    };
    this.requests.set(request.approvalId, request);
    this.emit('requested', request);
    return { request: this.publicRequest(request), owner: true, queued: false };
  }

  prepareAppApproval(
    approvalId,
    { hostSession = null, requestedDurationSeconds } = {},
  ) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error('Approval request cannot be presented from state=' + request.state + '.');
    }
    if (request.approvalNonceHash) {
      if (
        request.requestedDurationSeconds !== requestedDurationSeconds &&
        requestedDurationSeconds != null
      ) {
        throw new Error('Approval duration is already frozen for this approval_id.');
      }
      throw new Error('Approval request is already bound to an approval card.');
    }
    request.requestedDurationSeconds = requestedDurationSeconds;
    const approvalNonce = crypto.randomBytes(32).toString('base64url');
    request.approvalNonceHash = hashSecret(approvalNonce);
    request.hostSession = hostSession ? String(hostSession) : null;
    request.cardBoundAt = this.now();
    request.cardExpiresAt = request.cardBoundAt + this.boundTtlMs;
    this.emit('app_bound', request, {
      requested_duration_seconds: requestedDurationSeconds,
    });
    return {
      request: this.publicRequest(request),
      approvalNonce,
    };
  }

  assertAppRequest(request, approvalNonce, hostSession) {
    if (!request.approvalNonceHash) {
      throw new Error('Approval request is not bound to an approval card.');
    }
    if (!secretMatches(approvalNonce, request.approvalNonceHash)) {
      throw new Error('Approval nonce is invalid.');
    }
    if (request.hostSession && request.hostSession !== String(hostSession || '')) {
      throw new Error('Approval request belongs to a different host session.');
    }
  }

  readAppStatus(approvalId, approvalNonce, hostSession = null, receiptStore = null) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (request) {
      this.assertAppRequest(request, approvalNonce, hostSession);
      return {
        ...this.publicRequest(request),
        action_failed: request.actionFailed === true,
        result_unavailable: false,
      };
    }
    const archived = receiptStore?.read(approvalId, approvalNonce, hostSession);
    if (archived) return archived;
    throw new Error('Approval card state is unavailable.');
  }

  claim(approvalId, approvalNonce, hostSession = null) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error('Approval request cannot dispatch from state=' + request.state + '.');
    }
    this.assertAppRequest(request, approvalNonce, hostSession);
    if (!Number.isInteger(request.requestedDurationSeconds)) {
      throw new Error('Approval duration was not frozen before resolve.');
    }
    request.state = 'dispatching';
    request.approvedAt = this.now();
    request.dispatchStartedAt = this.now();
    this.emit('dispatching', request);
    return {
      request: this.publicRequest(request),
      action: structuredClone(request.action),
      requestedDurationSeconds: request.requestedDurationSeconds,
    };
  }

  deny(approvalId, approvalNonce, hostSession = null) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error('Approval request cannot be denied from state=' + request.state + '.');
    }
    this.assertAppRequest(request, approvalNonce, hostSession);
    request.state = 'denied';
    request.respondedAt = this.now();
    request.terminalReason = 'user_denied';
    this.recordTerminal(request);
    this.emit('responded', request, { decision: 'deny' });
    return this.publicRequest(request);
  }

  transition(approvalId, nextState, { actionFailed = false } = {}) {
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'dispatching') {
      throw new Error('Approval request is not dispatching; state=' + request.state + '.');
    }
    request.state = nextState;
    request.actionFailed = actionFailed === true;
    if (nextState === 'consumed') request.consumedAt = this.now();
    if (nextState === 'approved_retryable') request.retryableAt = this.now();
    if (nextState === 'execution_unknown') request.unknownAt = this.now();
    this.emit(nextState, request);
    this.recordTerminal(request, { actionFailed });
    return this.publicRequest(request);
  }

  markConsumed(approvalId, options = {}) {
    return this.transition(approvalId, 'consumed', options);
  }

  markRetryable(approvalId) {
    return this.transition(approvalId, 'approved_retryable');
  }

  markUnknown(approvalId) {
    return this.transition(approvalId, 'execution_unknown');
  }

  clearPendingAll(reason = 'policy_changed') {
    this.prune();
    const cleared = [];
    for (const request of this.requests.values()) {
      if (request.state !== 'pending') continue;
      request.state = 'superseded';
      request.supersededAt = this.now();
      request.terminalReason = reason;
      this.recordTerminal(request);
      this.emit('superseded', request, { reason });
      cleared.push(this.publicRequest(request));
    }
    return cleared;
  }

  lookup(approvalId) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    return request ? this.publicRequest(request) : null;
  }

  snapshot() {
    this.prune();
    const pending = [...this.requests.values()].filter((request) => request.state === 'pending');
    const deadlines = pending
      .map((request) => this.pendingDeadline(request))
      .filter((value) => value != null);
    return {
      pending_count: pending.length,
      pending_bound_count: pending.filter((request) => request.cardBoundAt != null).length,
      pending_unbound_count: pending.filter((request) => request.cardBoundAt == null).length,
      nearest_pending_expires_at: deadlines.length ? iso(Math.min(...deadlines)) : null,
    };
  }
}
