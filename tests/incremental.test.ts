import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IncrementalStability, IncrementalStowageRules } from '../src/utils/incremental.ts';
import { VESSEL, BAYS, PORTS, CONTAINERS } from '../src/utils/mockData.ts';
import { calculateStability } from '../src/utils/stability.ts';
import type { Placement } from '../src/types/shipping.ts';

const placements: Placement[] = [
  { id: 'x1', containerId: 'C001', bayId: 2, row: 1, tier: 1, placedAt: '' },
  { id: 'x2', containerId: 'C002', bayId: 4, row: 2, tier: 2, placedAt: '' },
  { id: 'x3', containerId: 'C003', bayId: 6, row: 3, tier: 1, placedAt: '' },
  { id: 'x4', containerId: 'C004', bayId: 8, row: 4, tier: 2, placedAt: '' },
];

test('稳性增量：首次全部重算，未变箱沿用，移动一箱仅重算一箱', () => {
  const calc = new IncrementalStability();
  const first = calc.calculate(placements, CONTAINERS, BAYS, VESSEL);
  assert.equal(calc.stats().recomputed, 4);
  assert.equal(calc.stats().reused, 0);

  // 与全量计算结果一致
  const full = calculateStability(placements, CONTAINERS, BAYS, VESSEL);
  assert.ok(Math.abs(first.gm - full.gm) < 1e-9);
  assert.ok(Math.abs(first.heel - full.heel) < 1e-9);

  // 移动 x3
  const moved = placements.map((item) =>
    item.id === 'x3' ? { ...item, bayId: 10, row: 5 } : item,
  );
  const second = calc.calculate(moved, CONTAINERS, BAYS, VESSEL);
  assert.equal(calc.stats().reused, 3);
  assert.equal(calc.stats().recomputed, 1);
  const fullMoved = calculateStability(moved, CONTAINERS, BAYS, VESSEL);
  assert.ok(Math.abs(second.gm - fullMoved.gm) < 1e-9);
  assert.ok(Math.abs(second.lcg - fullMoved.lcg) < 1e-9);

  // 无变化时全部沿用，稳性结果不变
  calc.calculate(moved, CONTAINERS, BAYS, VESSEL);
  assert.equal(calc.stats().reused, 4);
  assert.equal(calc.stats().recomputed, 0);
});

test('规则增量：不动的栈整栈沿用，改动的栈整栈重算', () => {
  const calc = new IncrementalStowageRules();
  const stability = calculateStability(placements, CONTAINERS, BAYS, VESSEL);
  calc.validate(placements, CONTAINERS, BAYS, PORTS, stability);
  assert.equal(calc.stats().recomputed, 4);

  // x3 同栈移动 tier（仍在贝 6 排 3）
  const moved = placements.map((item) =>
    item.id === 'x3' ? { ...item, tier: 3 } : item,
  );
  const movedStability = calculateStability(moved, CONTAINERS, BAYS, VESSEL);
  calc.validate(moved, CONTAINERS, BAYS, PORTS, movedStability);
  // 贝 6/排 3 栈重算 1 箱，其余 3 箱沿用
  assert.equal(calc.stats().recomputed, 1);
  assert.equal(calc.stats().reused, 3);
});
