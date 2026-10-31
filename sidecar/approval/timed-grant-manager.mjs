export const DEFAULT_GRANT_TERMINAL_RETENTION_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_GRANT_TERMINAL_RETENTION_LIMIT = 1000;

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

export class TimedGrantManager {
  constructor({
    now = () => Date.now(),
    audit = null,
    terminalRetentionMs = DEFAULT_GRANT_TERMINAL_RETENTION_MS,
    terminalRetentionLimit = DEFAULT_GRANT_TERMINAL_RETENTION_LIMIT,
  } = {}) {
    this.now = now;
    this.audit = audit;
    this.terminalRetentionMs = Number.isFinite(Number(terminalRetentionMs)) && Number(terminalRetentionMs) > 0
      ? Number(terminalRetentionMs)
      : DEFAULT_GRANT_TERMINAL_RETENTION_MS;
    this.terminalRetentionLimit = Number.isInteger(Number(terminalRetentionLimit)) && Number(terminalRetentionLimit) > 0
      ? Number(terminalRetentionLimit)
      : DEFAULT_GRANT_TERMINAL_RETENTION_LIMIT;
    this.records = new Map();
  }

  emit(event, record, extra = {}) {
    if (!this.audit) return;
    this.audit({
      event,
      approval_id: record?.approvalId || null,
      operation_id: record?.operationId || null,
      grant_state: record?.state || null,
      requested_duration_seconds: record?.requestedDurationSeconds || null,
      granted_at: iso(record?.grantedAt),
      expires_at: iso(record?.expiresAt),
      terminal_reason: record?.terminalReason || null,
      ...extra,
    });
  }

  publicRecord(record) {
    if (!record) return null;
    const remainingMs = record.state === 'active'
      ? Math.max(0, record.expiresAt - this.now())
      : 0;
    return {
      approval_id: record.approvalId,
      grant_state: record.state,
      requested_duration_seconds: record.requestedDurationSeconds,
      granted_at: iso(record.grantedAt),
      expires_at: iso(record.expiresAt),
      remaining_seconds: Math.ceil(remainingMs / 1000),
      operation_id: record.operationId,
      policy_revision: record.policyRevision,
      terminal_reason: record.terminalReason || null,
    };
  }

  prune() {
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.state === 'active' && now >= record.expiresAt) {
        record.state = 'expired';
        record.terminatedAt = record.expiresAt;
        record.terminalReason = 'duration_elapsed';
        this.emit('grant_expired', record);
      }
    }
    for (const [approvalId, record] of this.records) {
      if (
        record.state !== 'active' &&
        record.terminatedAt != null &&
        record.terminatedAt + this.terminalRetentionMs <= now
      ) {
        this.records.delete(approvalId);
      }
    }
    const terminal = [...this.records.values()]
      .filter((record) => record.state !== 'active' && record.terminatedAt != null)
      .sort((a, b) => a.terminatedAt - b.terminatedAt);
    const excess = terminal.length - this.terminalRetentionLimit;
    for (let index = 0; index < excess; index += 1) {
      this.records.delete(terminal[index].approvalId);
    }
  }

  active(approvalId) {
    this.prune();
    const record = this.records.get(String(approvalId || ''));
    return record?.state === 'active' ? this.publicRecord(record) : null;
  }

  inspect(approvalId) {
    this.prune();
    return this.publicRecord(this.records.get(String(approvalId || '')));
  }

  grant({
    approvalId,
    requestedDurationSeconds,
    operationId,
    policyRevision = 0,
  }) {
    this.prune();
    if (typeof approvalId !== 'string' || !approvalId) {
      throw new Error('approvalId is required.');
    }
    if (!Number.isInteger(requestedDurationSeconds) || requestedDurationSeconds <= 0) {
      throw new Error('requestedDurationSeconds must be a positive integer.');
    }
    if (this.records.has(approvalId)) {
      throw new Error('A BMG grant record already exists for this approval_id.');
    }
    const grantedAt = this.now();
    const record = {
      approvalId,
      state: 'active',
      requestedDurationSeconds,
      grantedAt,
      expiresAt: grantedAt + requestedDurationSeconds * 1000,
      operationId: String(operationId || ''),
      policyRevision: Number(policyRevision || 0),
      terminatedAt: null,
      terminalReason: null,
    };
    this.records.set(approvalId, record);
    this.emit('grant_created', record);
    return this.publicRecord(record);
  }

  clear(approvalId, reason = 'revoked') {
    this.prune();
    const record = this.records.get(String(approvalId || ''));
    if (!record || record.state !== 'active') return this.publicRecord(record);
    record.state = 'revoked';
    record.terminatedAt = this.now();
    record.terminalReason = reason;
    this.emit('grant_revoked', record, { reason });
    return this.publicRecord(record);
  }

  clearAll(reason = 'cleared') {
    this.prune();
    const cleared = [];
    for (const record of this.records.values()) {
      if (record.state !== 'active') continue;
      record.state = 'revoked';
      record.terminatedAt = this.now();
      record.terminalReason = reason;
      this.emit('grant_revoked', record, { reason });
      cleared.push(this.publicRecord(record));
    }
    return cleared;
  }

  snapshot() {
    this.prune();
    const active = [...this.records.values()].filter((record) => record.state === 'active');
    const expiries = active.map((record) => record.expiresAt);
    return {
      grant_count: active.length,
      nearest_grant_expires_at: expiries.length ? iso(Math.min(...expiries)) : null,
    };
  }
}
