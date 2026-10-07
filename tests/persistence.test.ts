import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { configureStore } from '@reduxjs/toolkit';
import { plannerReducer, plannerActions } from '../src/stores/plannerSlice.ts';
import { SaveManager, createPersistenceMiddleware } from '../src/stores/persistence.ts';

function createMemoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage & { map: Map<string, string> };
}

function setup(shouldFail: () => boolean = () => false, backoffMs = [20, 40, 80]) {
  const storage = createMemoryStorage();
  const manager = new SaveManager({ storage, shouldFail, backoffMs: backoffMs as number[] });
  const middleware = createPersistenceMiddleware({ manager });
  const store = configureStore({
    reducer: { planner: plannerReducer },
    middleware: (getDefault) => getDefault({ serializableCheck: false }).concat(middleware),
  });
  return { storage, manager, store };
}

afterEach(() => {
  // 让定时器自然过期，避免进程悬挂
  return new Promise((resolve) => setTimeout(resolve, 120));
});

test('写盘成功后状态与操作号台账落盘', async () => {
  const { manager, store, storage } = setup();
  store.dispatch(plannerActions.setNotice('不应触发写盘'));
  store.dispatch(
    plannerActions.assignContainer({
      containerId: 'C001',
      slot: { bayId: 2, row: 1, tier: 1 },
    }),
  );
  await manager.flush();
  const raw = storage.getItem('pair-wise-yy-21.planner');
  assert.ok(raw);
  const persisted = JSON.parse(raw);
  assert.ok(persisted.plans[0].placements.some((p: { containerId: string }) => p.containerId === 'C001'));
  const journal = JSON.parse(storage.getItem('pair-wise-yy-21.planner.ops')!);
  assert.equal(Array.isArray(journal.applied), true);
  assert.ok(journal.applied.length >= 1);
});

test('同一操作号重复提交只执行一次', async () => {
  const { manager, store } = setup();
  const opId = 'OP-DUP-1';
  const before = store.getState().planner.plans[0].placements.length;
  store.dispatch(
    plannerActions.assignContainer({
      containerId: 'C050',
      slot: { bayId: 2, row: 1, tier: 1 },
      opId,
    }),
  );
  // 重复提交：不同格位也必须被丢弃
  store.dispatch(
    plannerActions.assignContainer({
      containerId: 'C050',
      slot: { bayId: 4, row: 2, tier: 2 },
      opId,
    }),
  );
  await manager.flush();
  const placements = store.getState().planner.plans[0].placements;
  const c = placements.filter((p) => p.containerId === 'C050');
  assert.equal(c.length, 1);
  assert.equal(c[0].bayId, 2);
  assert.equal(placements.length, before);
});

test('写盘失败后按同一操作号退避重试，恢复后成功', async () => {
  let fail = true;
  const { manager, storage } = setup(() => fail, [20, 30]);
  // 直接驱动管理器，绕过去抖
  const fakeState = {
    plans: [{ id: 'P', name: 'n' }],
    activePlanId: 'P',
  } as never;
  manager.schedule('OP-FAIL-9', fakeState);
  let result = await manager.flush();
  assert.equal(result, false);
  assert.equal(manager.snapshot().phase, 'retrying');
  assert.equal(manager.snapshot().pendingOpId, 'OP-FAIL-9');
  assert.equal(storage.getItem('pair-wise-yy-21.planner'), null);

  // 等待退避重试（仍失败）
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(storage.getItem('pair-wise-yy-21.planner'), null);

  // 恢复写盘，手动按操作号重试成功
  fail = false;
  result = await manager.flush();
  assert.equal(result, true);
  const raw = storage.getItem('pair-wise-yy-21.planner');
  assert.ok(raw);
  const journal = JSON.parse(storage.getItem('pair-wise-yy-21.planner.ops')!);
  assert.equal(journal.lastSavedOpId, 'OP-FAIL-9');
  assert.equal(manager.snapshot().phase, 'saved');
});

test('新操作覆盖挂起状态时重置尝试次数与操作号', async () => {
  let fail = true;
  const { manager } = setup(() => fail, [20]);
  manager.schedule('OP-OLD', {} as never);
  await manager.flush();
  assert.equal(manager.snapshot().attempts, 1);
  fail = false;
  manager.schedule('OP-NEW', {} as never);
  assert.equal(manager.snapshot().attempts, 0);
  assert.equal(manager.snapshot().pendingOpId, 'OP-NEW');
});
