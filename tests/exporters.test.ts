import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifestCsv } from '../src/utils/manifestCsv.ts';
import { BAYS, CONTAINERS, PORTS, VESSEL } from '../src/utils/mockData.ts';
import { calculateStability } from '../src/utils/stability.ts';
import type { Placement } from '../src/types/shipping.ts';

test('清单包含插口占用列、贝位插口统计与待供电明细', () => {
  // 取前 4 个箱，其中 C004 是 20RF 冷藏箱
  const placements: Placement[] = [1, 2, 3, 4].map((index, tier0) => ({
    id: `M${index}`,
    containerId: `C00${index}`,
    bayId: 2,
    row: index,
    tier: tier0 + 1,
    placedAt: '',
  }));
  const plan = {
    id: 'PLAN-X',
    name: '导出测试方案',
    status: 'trial' as const,
    note: '',
    createdAt: '',
    updatedAt: '',
    placements,
    pendingReefers: [{ containerId: 'C008', enqueuedAt: 1 }],
  };
  const stability = calculateStability(placements, CONTAINERS, BAYS, VESSEL);
  const csv = buildManifestCsv(plan, CONTAINERS, PORTS, stability, {
    bays: BAYS,
    pendingReefers: plan.pendingReefers,
  });

  assert.match(csv, /插口状态/);
  assert.match(csv, /贝位供电插口统计/);
  assert.match(csv, /待供电冷藏箱明细/);
  assert.match(csv, /已供电/);
  // C008 是 20RF 冷藏箱（箱号 CMAU5363311），应出现在待供电明细中
  assert.match(csv, /CMAU5363311/);
  assert.match(csv, /检修停用|检修停/);
  assert.match(csv, /待供电冷箱/);
});
