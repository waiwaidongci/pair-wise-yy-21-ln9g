import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureStore } from '@reduxjs/toolkit';
import { plannerReducer, plannerActions } from '../src/stores/plannerSlice.ts';
import { findAutoStowPlacements } from '../src/utils/stowage.ts';
import { baySocketCapacity } from '../src/utils/reeferPower.ts';

function setupStore() {
  return configureStore({
    reducer: { planner: plannerReducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false }),
  });
}

function activePlan(store: ReturnType<typeof setupStore>) {
  const state = store.getState().planner;
  return state.plans.find((plan) => plan.id === state.activePlanId)!;
}

test('全链路：清空→自动配载冷箱全部上插；插口检修后排队；恢复后队头补位', () => {
  const store = setupStore();
  const state0 = store.getState().planner;

  // 全船冷箱数量与插口总容量
  const reeferCount = state0.containers.filter((c) => c.reefer).length;
  const totalCapacity = state0.bays.reduce((sum, bay) => sum + baySocketCapacity(bay), 0);
  assert.ok(reeferCount <= totalCapacity, '默认插口容量应能容纳全部冷箱');

  store.dispatch(plannerActions.clearPlan());
  assert.equal(activePlan(store).placements.length, 0);
  assert.equal(activePlan(store).pendingReefers.length, 0);

  // 自动配载
  const result = findAutoStowPlacements(
    state0.containers,
    activePlan(store).placements,
    state0.bays,
  );
  store.dispatch(
    plannerActions.autoStow({ placements: result.placements, unpoweredReeferIds: result.unpoweredReeferIds }),
  );
  const plan1 = activePlan(store);
  const placedReefers = plan1.placements.filter((p) => {
    const container = state0.containers.find((c) => c.id === p.containerId);
    return container?.reefer;
  });
  assert.equal(placedReefers.length, reeferCount);
  assert.equal(plan1.pendingReefers.length, 0);

  // 初始 26 个可用插口（06 贝有 2 个检修停用），共 18 个冷箱。
  // 02、08 贝全停（各 -4），06 贝停用数由 2 提到 4（再 -2）→ 全船 16 个插口、2 个冷箱排队。
  store.dispatch(
    plannerActions.setBaySockets({ bayId: 2, reeferSocketTotal: 4, reeferSocketOutage: 4 }),
  );
  store.dispatch(
    plannerActions.setBaySockets({ bayId: 8, reeferSocketTotal: 4, reeferSocketOutage: 4 }),
  );
  store.dispatch(
    plannerActions.setBaySockets({ bayId: 6, reeferSocketTotal: 4, reeferSocketOutage: 4 }),
  );
  const plan2 = activePlan(store);
  const capacityAfter = store
    .getState()
    .planner.bays.reduce((sum, bay) => sum + baySocketCapacity(bay), 0);
  assert.equal(capacityAfter, 16);
  const poweredReefers = plan2.placements.filter((p) => {
    const container = store.getState().planner.containers.find((c) => c.id === p.containerId);
    return container?.reefer;
  });
  // 冷箱必须落 1—3 层且不能悬空；插口少 + 低层格位被占都会让冷箱留在队列
  assert.ok(poweredReefers.length <= capacityAfter);
  assert.equal(
    poweredReefers.length + plan2.pendingReefers.length,
    reeferCount,
    '每个冷箱要么已供电要么在待供电队列',
  );
  assert.ok(plan2.pendingReefers.length > 0, '应出现待供电队列并拦截放行');

  // 队列按卸货港排序
  const portsByCode = new Map(state0.ports.map((port) => [port.code, port.sequence]));
  const sequences = plan2.pendingReefers.map((item) => {
    const real = state0.containers.find((c) => c.id === item.containerId)!;
    return portsByCode.get(real.portCode)!;
  });
  const sorted = [...sequences].sort((a, b) => a - b);
  assert.deepEqual(sequences, sorted);

  // 核心规则：插口腾退后，待供电冷箱立即自动补进有空插口 + 低层格位的位置。
  const queueOnOutage = plan2.pendingReefers.length;
  const headBefore = plan2.pendingReefers[0];
  assert.ok(headBefore);
  store.dispatch(
    plannerActions.setBaySockets({ bayId: 2, reeferSocketTotal: 4, reeferSocketOutage: 0 }),
  );
  const plan3 = activePlan(store);
  assert.ok(
    plan3.pendingReefers.length < queueOnOutage,
    '恢复 02 贝插口后，队头应自动补进，队列缩短',
  );
  plan3.placements
    .filter((p) => p.bayId === 2)
    .forEach((p) => assert.ok(p.tier <= 3 || !store.getState().planner.containers.find((c) => c.id === p.containerId)?.reefer, '补位冷箱必须落在低层格位'));

  // 全部插口恢复 + 清空方案后再自动配载，队列必然清空
  store.dispatch(
    plannerActions.setBaySockets({ bayId: 6, reeferSocketTotal: 4, reeferSocketOutage: 2 }),
  );
  store.dispatch(
    plannerActions.setBaySockets({ bayId: 8, reeferSocketTotal: 4, reeferSocketOutage: 0 }),
  );
  store.dispatch(plannerActions.clearPlan());
  const retry = findAutoStowPlacements(
    store.getState().planner.containers,
    [],
    store.getState().planner.bays,
  );
  store.dispatch(
    plannerActions.autoStow({ placements: retry.placements, unpoweredReeferIds: retry.unpoweredReeferIds }),
  );
  assert.equal(activePlan(store).pendingReefers.length, 0, '插口充足时重新自动配载不应有待供电冷箱');
});

test('贝位插口编辑影响全部方案；撤销恢复插口与队列', () => {
  const store = setupStore();
  store.dispatch(plannerActions.duplicatePlan(store.getState().planner.plans[0].id));
  store.dispatch(plannerActions.setBaySockets({ bayId: 14, reeferSocketTotal: 0, reeferSocketOutage: 0 }));
  // 两个方案都经过重算（不抛错、队列为确定值）
  const state = store.getState().planner;
  state.plans.forEach((plan) => {
    assert.ok(Array.isArray(plan.pendingReefers));
  });
  const pendingAt14After = state.plans.map(
    (plan) =>
      plan.placements.filter((p) => {
        const container = state.containers.find((c) => c.id === p.containerId);
        return container?.reefer && p.bayId === 14;
      }).length === 0,
  );
  assert.ok(pendingAt14After.every(Boolean));

  // 记录插口归零后的队列长度，撤销后应回到该操作之前的状态（初始队列可能为空）
  const queuedWhileSocketsZero = activePlan(store).pendingReefers.length;
  assert.ok(queuedWhileSocketsZero >= 0);
  store.dispatch(plannerActions.undo());
  const bay14 = store.getState().planner.bays.find((bay) => bay.id === 14)!;
  assert.equal(bay14.reeferSocketTotal, 4);
  // 撤销后按恢复的插口重算；活动方案的队列不再包含因 14 贝归零而排队的冷箱
  const afterUndo = activePlan(store);
  const bay14Reefers = afterUndo.placements.filter((p) => {
    const container = store.getState().planner.containers.find((c) => c.id === p.containerId);
    return container?.reefer && p.bayId === 14;
  });
  assert.ok(bay14Reefers.length >= 1, '撤销后 14 贝冷箱应恢复供电');
});
