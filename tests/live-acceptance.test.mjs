import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLiveService } from '../scripts/check-bmg-live.mjs';

test('post-deployment live BMG release gate (6v only; does not restart services)', async () => {
  assert.equal(await checkLiveService(), true,
    'BMG is NOT DELIVERED until every mandatory live tool case passes');
});
