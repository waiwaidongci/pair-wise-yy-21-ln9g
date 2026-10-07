import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileReeferPower, baySocketCapacity } from '../src/utils/reeferPower.ts';
import type { Bay, Container, Placement, Port, StowagePlan } from '../src/types/shipping.ts';

const ports: Port[] = [
  { code: 'P1', name: '港一', country: 'X', sequence: 1, color: '#000' },
  { code: 'P2', name: '港二', country: 'X', sequence: 2, color: '#000' },
  { code: 'P3', name: '港三', country: 'X', sequence: 3, color: '#000' },
];

function makeContainer(id: string, portCode: string): Container {
  return {
    id,
    number: id,
    type: '20RF',
    grossWeight: 18,
    tareWeight: 3.2,
    payload: 14.8,
    portCode,
    hazardClass: 'none',
    reefer: true,
    cargo: '冷链食品',
  };
}

function makeBay(id: number, total: number, outage = 0): Bay {
  return {
    id,
    name: String(id),
    longitudinalPosition: id,
    rows: 4,
    tiers: 4,
    maxStackWeight: 200,
    reeferSocketTotal: total,
    reeferSocketOutage: outage,
  };
}

function placement(id: string, containerId: string, bayId: number, row: number, tier: number): Placement {
  return { id, containerId, bayId, row, tier, placedAt: '2026-10-07T00:00:00.000Z' };
}

function makePlan(placements: Placement[], pendingReefers: StowagePlan['pendingReefers'] = []): StowagePlan {
  return {
    id: 'PLAN-T',
    name: '测试方案',
    status: 'trial',
    note: '',
    createdAt: '',
    updatedAt: '',
    placements,
    pendingReefers,
  };
}

test('插口容量 = 总数 - 检修停用', () => {
  assert.equal(baySocketCapacity(makeBay(2, 4, 2)), 2);
  assert.equal(baySocketCapacity(makeBay(2, 4, 6)), 0);
});

test('贝位冷箱超过插口容量：后卸港冷箱被腾退，先卸港冷箱保留', () => {
  const containers = [
    makeContainer('R-EARLY', 'P1'),
    makeContainer('R-LATE', 'P3'),
    makeContainer('R-MID', 'P2'),
  ];
  const bays = [makeBay(2, 2, 0)];
  const plan = makePlan([
    placement('p1', 'R-EARLY', 2, 1, 1),
    placement('p2', 'R-LATE', 2, 2, 1),
    placement('p3', 'R-MID', 2, 3, 1),
  ]);
  const result = reconcileReeferPower(plan, containers, bays, ports, { nextSequence: 1 });
  const poweredIds = result.placements.map((item) => item.containerId).sort();
  assert.deepEqual(poweredIds, ['R-EARLY', 'R-MID']);
  assert.equal(result.evictedContainerIds[0], 'R-LATE');
  assert.deepEqual(result.pendingReefers.map((item) => item.containerId), ['R-LATE']);
  assert.equal(result.socketUsageByBay.get(2), 2);
});

test('检修停用增加后队列排队，恢复插口后队头自动补进低层格位', () => {
  const containers = [makeContainer('R1', 'P1'), makeContainer('R2', 'P2'), makeContainer('R3', 'P3')];
  let bays = [makeBay(2, 3, 0)];
  let plan = makePlan([
    placement('p1', 'R1', 2, 1, 1),
    placement('p2', 'R2', 2, 2, 1),
    placement('p3', 'R3', 2, 3, 1),
  ]);
  const first = reconcileReeferPower(plan, containers, bays, ports, { nextSequence: 1 });
  assert.equal(first.pendingReefers.length, 0);

  // 1 个插口检修停用：后卸港 R3 失效入队
  bays = [makeBay(2, 3, 1)];
  plan = makePlan(first.placements, first.pendingReefers);
  const second = reconcileReeferPower(plan, containers, bays, ports);
  assert.deepEqual(second.pendingReefers.map((item) => item.containerId), ['R3']);
  assert.equal(second.placements.length, 2);

  // 另一贝位新增可用插口 → 队头 R3 自动补进 1 层
  bays = [makeBay(2, 3, 1), makeBay(4, 1, 0)];
  plan = makePlan(second.placements, second.pendingReefers);
  const third = reconcileReeferPower(plan, containers, bays, ports, { idPrefix: 'FILL' });
  assert.equal(third.pendingReefers.length, 0);
  const promoted = third.placements.find((item) => item.containerId === 'R3');
  assert.ok(promoted);
  assert.equal(promoted!.bayId, 4);
  assert.equal(promoted!.tier, 1);
  assert.deepEqual(third.promotedContainerIds, ['R3']);
});

test('队列严格按卸货港先后排序（入队序仅作同港决胜）', () => {
  const containers = [makeContainer('R-A', 'P3'), makeContainer('R-B', 'P1'), makeContainer('R-C', 'P2')];
  const bays = [makeBay(2, 0, 0)];
  const plan = makePlan([
    placement('p1', 'R-A', 2, 1, 1),
    placement('p2', 'R-B', 2, 2, 1),
    placement('p3', 'R-C', 2, 3, 1),
  ]);
  const result = reconcileReeferPower(plan, containers, bays, ports, { nextSequence: 1 });
  assert.deepEqual(
    result.pendingReefers.map((item) => item.containerId),
    ['R-B', 'R-C', 'R-A'],
  );
});

test('显式候选进入队列；插口腾退时队头先补，后面继续等待', () => {
  const containers = [makeContainer('R1', 'P1'), makeContainer('R2', 'P2')];
  const bays = [makeBay(2, 1, 0)];
  const plan = makePlan([placement('p1', 'R1', 2, 1, 1)]);
  const queued = reconcileReeferPower(plan, containers, bays, ports, {
    enqueueCandidates: ['R2'],
    nextSequence: 1,
  });
  assert.deepEqual(queued.pendingReefers.map((item) => item.containerId), ['R2']);

  // R1 移除后 R2 自动补位
  const emptied = makePlan(
    queued.placements.filter((item) => item.containerId !== 'R1'),
    queued.pendingReefers,
  );
  const filled = reconcileReeferPower(emptied, containers, bays, ports);
  assert.equal(filled.pendingReefers.length, 0);
  assert.ok(filled.placements.some((item) => item.containerId === 'R2' && item.tier <= 3));
});

test('未受影响的 placement 对象被原样沿用', () => {
  const containers = [makeContainer('R1', 'P1'), makeContainer('R2', 'P2')];
  const bays = [makeBay(2, 1, 0), makeBay(4, 1, 0)];
  const stable = placement('p1', 'R1', 2, 1, 1);
  const plan = makePlan([stable, placement('p2', 'R2', 4, 1, 1)]);
  const result = reconcileReeferPower(plan, containers, bays, ports, { nextSequence: 1 });
  const same = result.placements.find((item) => item.id === 'p1');
  assert.equal(same, stable);
});
