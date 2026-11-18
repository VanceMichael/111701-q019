import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, submissionKey } from '../src/reconcile.mjs';

test('超时没有回执时留在待核实队列，不判成功也不判失败', () => {
  const result = reconcile({
    pending: [{ invoiceId: 'INV-1', batchId: 'B-1', status: 'timeout' }],
    receipts: [],
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].invoiceId, 'INV-1');
  assert.equal(result.needsVerification[0].batchId, 'B-1');
  assert.equal(result.needsVerification[0].reason, 'no_receipt');
});

test('超时后查到门户受理回执时判为已受理，而不是按超时判失败', () => {
  const result = reconcile({
    pending: [{ invoiceId: 'INV-1', batchId: 'B-1', status: 'timeout' }],
    receipts: [
      { invoiceId: 'INV-1', batchId: 'B-1', status: 'queued', receiptId: 'R-1' },
    ],
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].reason, 'portal_accepted');
  assert.deepEqual(result.accepted[0].receiptIds, ['R-1']);
  assert.equal(result.needsVerification.length, 0);
  assert.equal(result.rejected.length, 0);
});

test('只有超时回执时仍然待核实，不允许当作失败重试', () => {
  const result = reconcile({
    pending: [{ invoiceId: 'INV-1', batchId: 'B-1', status: 'submitted' }],
    receipts: [{ invoiceId: 'INV-1', batchId: 'B-1', status: 'gateway_timeout' }],
  });

  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].reason, 'portal_timeout');
  assert.equal(result.rejected.length, 0);
});

test('明确拒绝回执才进入失败队列', () => {
  const result = reconcile({
    pending: [{ invoiceId: 'INV-2', batchId: 'B-1' }],
    receipts: [{ invoiceId: 'INV-2', batchId: 'B-1', status: '已拒绝' }],
  });

  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'portal_rejected');
});

test('同一发票不同批次分别对账，不会被合并', () => {
  const result = reconcile({
    pending: [
      { invoiceId: 'INV-1', batchId: 'B-1' },
      { invoiceId: 'INV-1', batchId: 'B-2' },
    ],
    receipts: [{ invoiceId: 'INV-1', batchId: 'B-2', status: 'accepted' }],
  });

  assert.equal(result.summary.reconciliationUnits, 2);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].batchId, 'B-2');
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].batchId, 'B-1');
});

test('同一身份的重试记录合并计数，且幂等键稳定', () => {
  const result = reconcile({
    pending: [
      { invoiceId: 'INV-1', batchId: 'B-1', status: 'timeout' },
      { invoiceId: 'INV-1', batchId: 'B-1', status: 'timeout' },
      { invoiceId: 'INV-1', batchId: 'B-1', status: 'timeout' },
    ],
    receipts: [],
  });

  assert.equal(result.summary.localEntries, 3);
  assert.equal(result.summary.reconciliationUnits, 1);
  assert.equal(result.needsVerification[0].attemptCount, 3);
  assert.equal(
    result.needsVerification[0].idempotencyKey,
    submissionKey('INV-1', 'B-1'),
  );
});

test('受理与拒绝回执冲突时需要人工核实', () => {
  const result = reconcile({
    pending: [{ invoiceId: 'INV-1', batchId: 'B-1' }],
    receipts: [
      { invoiceId: 'INV-1', batchId: 'B-1', status: 'queued' },
      { invoiceId: 'INV-1', batchId: 'B-1', status: 'rejected' },
    ],
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].reason, 'conflicting_receipts');
});

test('无法归属的回执单独保留，不静默丢弃', () => {
  const result = reconcile({
    pending: [{ invoiceId: 'INV-1', batchId: 'B-1' }],
    receipts: [
      { invoiceId: 'INV-9', batchId: 'B-1', status: 'accepted' },
      { status: 'accepted' },
    ],
  });

  assert.equal(result.summary.unmatchedReceipts, 2);
  assert.deepEqual(
    result.unmatchedReceipts.map((entry) => entry.reason),
    ['no_matching_local_entry', 'missing_identity'],
  );
  // 本地的 INV-1 并不因为存在别人的受理回执而被判成功。
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].reason, 'no_receipt');
});

test('本地待办缺少身份字段时拒绝处理', () => {
  assert.throws(() => reconcile({ pending: [{ invoiceId: 'INV-1' }] }), /batchId/);
});
