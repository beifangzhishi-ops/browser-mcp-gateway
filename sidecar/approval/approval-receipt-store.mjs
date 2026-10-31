import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const APPROVAL_RECEIPT_LIMIT = 4096;

function nonceMatches(nonce, hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false;
  const actual = crypto.createHash('sha256').update(String(nonce)).digest();
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

// Archived cards are display-only: this store never recreates pending actions or grants.
export class ApprovalReceiptStore {
  constructor({
    stateFile = null,
    now = () => Date.now(),
    retentionMs = APPROVAL_RECEIPT_RETENTION_MS,
    maxReceipts = APPROVAL_RECEIPT_LIMIT,
  } = {}) {
    this.stateFile = stateFile;
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxReceipts = maxReceipts;
    this.receipts = new Map();
    if (stateFile && fs.existsSync(stateFile)) {
      const content = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      for (const value of content?.receipts || []) {
        if (typeof value?.approval_id === 'string' &&
            Number.isFinite(value.saved_at) &&
            value.saved_at + retentionMs > now()) {
          this.receipts.set(value.approval_id, value);
        }
      }
      this.prune();
    }
  }

  prune() {
    for (const [id, value] of this.receipts) {
      if (value.saved_at + this.retentionMs <= this.now()) this.receipts.delete(id);
    }
    const excess = this.receipts.size - this.maxReceipts;
    if (excess > 0) {
      const oldest = [...this.receipts.values()]
        .sort((a, b) => a.saved_at - b.saved_at)
        .slice(0, excess);
      for (const value of oldest) this.receipts.delete(value.approval_id);
    }
  }

  save(request, { state = request.state, actionFailed = false } = {}) {
    if (!request.approvalNonceHash || !request.cardBoundAt ||
        !['denied', 'consumed', 'execution_unknown', 'approved_retryable', 'expired', 'superseded'].includes(state)) {
      return;
    }
    const value = {
      approval_id: request.approvalId,
      operation_id: request.operationId,
      scope_id: request.action.scopeId,
      tool_name: request.action.toolName,
      nonce_hash: request.approvalNonceHash.toString('hex'),
      host_session: request.hostSession || null,
      state,
      action_failed: actionFailed === true,
      saved_at: this.now(),
    };
    this.receipts.set(value.approval_id, value);
    this.prune();
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = this.stateFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, receipts: [...this.receipts.values()] }) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      fs.renameSync(temporary, this.stateFile);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  read(approvalId, nonce, hostSession) {
    this.prune();
    const value = this.receipts.get(String(approvalId || ''));
    if (!value) return null;
    if (!nonceMatches(nonce, value.nonce_hash) ||
        (value.host_session && value.host_session !== String(hostSession || ''))) {
      throw new Error('Approval card capability is invalid.');
    }
    const { nonce_hash, host_session, saved_at, ...visible } = value;
    return { ...visible, approval_required: false, result_unavailable: true };
  }
}
