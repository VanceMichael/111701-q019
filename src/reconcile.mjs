// 把本地待办录入与门户回执按「发票 + 录入批次」对账。
//
// 门户超时并不代表远端失败：发票可能已经进入审核队列。因此这里只承认
// 有明确回执证据的结果：
//   - 受理类回执 -> accepted
//   - 拒绝类回执 -> rejected
//   - 超时、未知、缺失、冲突等 -> needsVerification
//
// needsVerification 是待人工核实队列。调用方不得把它当作失败重试，也不得
// 当作成功入账，否则会产生重复审核或漏账。

const ACCEPTED_STATUSES = new Set([
  'accepted',
  'accept',
  'queued',
  'queue',
  'queued_for_review',
  'in_review',
  'under_review',
  'reviewing',
  'received',
  'processing',
  'duplicate',
  'already_queued',
  // 常见中文门户状态
  '已受理',
  '已入队',
  '审核中',
  '处理中',
  '重复提交',
]);

const REJECTED_STATUSES = new Set([
  'rejected',
  'reject',
  'refused',
  'denied',
  'invalid',
  'validation_failed',
  'validation_error',
  // 常见中文门户状态
  '已拒绝',
  '已退回',
  '校验失败',
]);

// 这些状态只说明「没拿到确定结果」，绝不能据此判成功或失败。
const TIMEOUT_STATUSES = new Set([
  'timeout',
  'timed_out',
  'gateway_timeout',
  'request_timeout',
  '超时',
]);

/**
 * 发票 + 录入批次的幂等键。同一张发票在同一批次内只应对应一次远端审核，
 * 重试前必须先用该键查清远端结果。
 */
export function submissionKey(invoiceId, batchId) {
  return JSON.stringify([String(batchId).trim(), String(invoiceId).trim()]);
}

function readText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeStatus(value) {
  const text = readText(value);
  if (!text) return null;
  return text.toLowerCase().replace(/[\s-]+/g, '_');
}

function readLocalIdentity(entry) {
  const invoiceId = readText(entry?.invoiceId);
  const batchId = readText(entry?.batchId);
  if (!invoiceId || !batchId) {
    throw new TypeError('本地待办缺少 invoiceId 或 batchId');
  }
  return { invoiceId, batchId };
}

function tryReadReceiptIdentity(receipt) {
  const invoiceId = readText(receipt?.invoiceId);
  const batchId = readText(receipt?.batchId);
  if (!invoiceId || !batchId) return null;
  return { invoiceId, batchId };
}

function classifyReceipt(receipt) {
  const status = normalizeStatus(receipt?.status ?? receipt?.state);
  if (!status) return 'unreadable';
  if (ACCEPTED_STATUSES.has(status)) return 'accepted';
  if (REJECTED_STATUSES.has(status)) return 'rejected';
  if (TIMEOUT_STATUSES.has(status)) return 'timeout';
  return 'unknown';
}

function classifyGroup(receipts) {
  const kinds = receipts.map(classifyReceipt);

  // 受理与拒绝同时出现时，远端事实自相矛盾，只能人工核实。
  if (kinds.includes('accepted') && kinds.includes('rejected')) {
    return { status: 'needs_verification', reason: 'conflicting_receipts' };
  }
  if (kinds.includes('accepted')) {
    return { status: 'accepted', reason: 'portal_accepted' };
  }
  if (kinds.includes('rejected')) {
    return { status: 'rejected', reason: 'portal_rejected' };
  }
  if (receipts.length === 0) {
    return { status: 'needs_verification', reason: 'no_receipt' };
  }
  if (kinds.includes('timeout')) {
    return { status: 'needs_verification', reason: 'portal_timeout' };
  }
  if (kinds.includes('unreadable')) {
    return { status: 'needs_verification', reason: 'unreadable_receipt' };
  }
  return { status: 'needs_verification', reason: 'ambiguous_receipt' };
}

/**
 * @param {object} input
 * @param {Array<{invoiceId: string, batchId: string, status?: string, state?: string}>} input.pending
 *   本地待办录入尝试。同一发票 + 批次出现多次时按一项对账。
 * @param {Array<{invoiceId: string, batchId: string, status?: string, state?: string, receiptId?: string}>} input.receipts
 *   门户回执。无法归属的回执不会被丢弃，而是放入 unmatchedReceipts。
 * @returns {{
 *   accepted: object[],
 *   rejected: object[],
 *   needsVerification: object[],
 *   unmatchedReceipts: object[],
 *   summary: object,
 * }}
 */
export function reconcile({ pending = [], receipts = [] } = {}) {
  if (!Array.isArray(pending)) throw new TypeError('pending 必须是数组');
  if (!Array.isArray(receipts)) throw new TypeError('receipts 必须是数组');

  // 本地同一身份可能因重试留下多条待办，对账时合并为一项，避免重复计数。
  const groups = new Map();
  for (const entry of pending) {
    const identity = readLocalIdentity(entry);
    const key = submissionKey(identity.invoiceId, identity.batchId);
    let group = groups.get(key);
    if (!group) {
      group = { ...identity, key, localEntries: [] };
      groups.set(key, group);
    }
    group.localEntries.push(entry);
  }

  const receiptsByKey = new Map([...groups.keys()].map((key) => [key, []]));
  const unmatchedReceipts = [];

  for (const receipt of receipts) {
    const identity = tryReadReceiptIdentity(receipt);
    if (!identity) {
      unmatchedReceipts.push({ receipt, reason: 'missing_identity' });
      continue;
    }
    const key = submissionKey(identity.invoiceId, identity.batchId);
    const bucket = receiptsByKey.get(key);
    if (!bucket) {
      unmatchedReceipts.push({ receipt, reason: 'no_matching_local_entry' });
      continue;
    }
    bucket.push(receipt);
  }

  const result = {
    accepted: [],
    rejected: [],
    needsVerification: [],
    unmatchedReceipts,
    summary: {
      localEntries: pending.length,
      reconciliationUnits: groups.size,
      accepted: 0,
      rejected: 0,
      needsVerification: 0,
      unmatchedReceipts: unmatchedReceipts.length,
    },
  };

  for (const group of groups.values()) {
    const groupReceipts = receiptsByKey.get(group.key);
    const classification = classifyGroup(groupReceipts);
    const item = {
      invoiceId: group.invoiceId,
      batchId: group.batchId,
      idempotencyKey: group.key,
      status: classification.status,
      reason: classification.reason,
      attemptCount: group.localEntries.length,
      localStatuses: [
        ...new Set(
          group.localEntries
            .map((entry) => readText(entry?.status ?? entry?.state))
            .filter(Boolean),
        ),
      ],
      receiptIds: groupReceipts
        .map((receipt) => readText(receipt?.receiptId))
        .filter(Boolean),
      receipts: groupReceipts,
    };

    if (classification.status === 'accepted') {
      result.accepted.push(item);
    } else if (classification.status === 'rejected') {
      result.rejected.push(item);
    } else {
      result.needsVerification.push(item);
    }
  }

  result.summary.accepted = result.accepted.length;
  result.summary.rejected = result.rejected.length;
  result.summary.needsVerification = result.needsVerification.length;

  return result;
}
