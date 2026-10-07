import { createSlice, nanoid } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type {
  Bay,
  OperationRecord,
  PersistState,
  Placement,
  PlannerState,
  Slot,
  StowagePlan,
} from '../types/shipping';
import { BAYS, CONTAINERS, createInitialPlans, PORTS, VESSEL } from '../utils/mockData';
import {
  computeReeferPower,
  materializeReeferPower,
  mergePowerWaitQueue,
  mergeReeferPowerInfo,
} from '../utils/reeferPower';

const initialPlans = createInitialPlans();

function buildInitialState(): PlannerState {
  const plans = recomputeAllReeferPower(initialPlans, CONTAINERS, PORTS, BAYS);
  return {
    vessel: VESSEL,
    ports: PORTS,
    bays: BAYS,
    containers: CONTAINERS,
    plans,
    activePlanId: plans[0].id,
    selectedContainerId: null,
    selectedSlot: null,
    highlightedConflictId: null,
    past: [],
    future: [],
    notice: null,
    operations: [],
    persist: { status: 'idle', lastOperationId: null, error: null, savedAt: null },
  };
}

const initialState: PlannerState = buildInitialState();

export const plannerSlice = createSlice({
  name: 'planner',
  initialState,
  reducers: {
    setActivePlan(state, action: PayloadAction<string>) {
      state.activePlanId = action.payload;
      state.selectedSlot = null;
      state.highlightedConflictId = null;
    },
    selectContainer(state, action: PayloadAction<string | null>) {
      state.selectedContainerId = action.payload;
    },
    selectSlot(state, action: PayloadAction<Slot | null>) {
      state.selectedSlot = action.payload;
    },
    assignContainer(
      state,
      action: PayloadAction<{ containerId: string; slot: Slot; operationId: string }>,
    ) {
      const plan = activePlan(state);
      if (!plan) return;
      applyOperation(state, action.payload.operationId, 'assign-container', () => {
        pushHistory(state);
        plan.placements = plan.placements.filter(
          (placement) =>
            placement.containerId !== action.payload.containerId &&
            !isSameSlot(placement, action.payload.slot),
        );
        plan.placements.push({
          ...action.payload.slot,
          id: nanoid(10),
          containerId: action.payload.containerId,
          placedAt: new Date().toISOString(),
        });
        plan.updatedAt = new Date().toISOString();
        state.selectedSlot = action.payload.slot;
        state.notice = '格位已更新，稳性、隔离与冷藏箱供电已重新计算';
        recomputePlanReeferPower(state, plan);
      });
    },
    removePlacement(state, action: PayloadAction<{ placementId: string; operationId: string }>) {
      const plan = activePlan(state);
      if (!plan) return;
      applyOperation(state, action.payload.operationId, 'remove-placement', () => {
        pushHistory(state);
        plan.placements = plan.placements.filter((placement) => placement.id !== action.payload.placementId);
        plan.updatedAt = new Date().toISOString();
        state.notice = '已从配载图中移除集装箱，供电插口已重新分配';
        recomputePlanReeferPower(state, plan);
      });
    },
    autoStow(state, action: PayloadAction<{ placements: Placement[]; operationId: string }>) {
      const plan = activePlan(state);
      if (!plan || action.payload.placements.length === 0) return;
      applyOperation(state, action.payload.operationId, 'auto-stow', () => {
        pushHistory(state);
        const incomingIds = new Set(action.payload.placements.map((placement) => placement.containerId));
        plan.placements = [
          ...plan.placements.filter((placement) => !incomingIds.has(placement.containerId)),
          ...action.payload.placements,
        ];
        plan.updatedAt = new Date().toISOString();
        state.notice = `自动配载已放入 ${action.payload.placements.length} 个集装箱，冷藏箱供电已重算`;
        recomputePlanReeferPower(state, plan);
      });
    },
    clearPlan(state, action: PayloadAction<{ operationId: string }>) {
      const plan = activePlan(state);
      if (!plan) return;
      applyOperation(state, action.payload.operationId, 'clear-plan', () => {
        pushHistory(state);
        plan.placements = [];
        plan.updatedAt = new Date().toISOString();
        state.selectedSlot = null;
        state.notice = '当前方案已清空，可通过撤销恢复';
        recomputePlanReeferPower(state, plan);
      });
    },
    duplicatePlan(state, action: PayloadAction<{ planId: string; operationId: string }>) {
      const source = state.plans.find((plan) => plan.id === action.payload.planId);
      if (!source) return;
      applyOperation(state, action.payload.operationId, 'duplicate-plan', () => {
        pushHistory(state);
        const id = `PLAN-${nanoid(5).toUpperCase()}`;
        const now = new Date().toISOString();
        state.plans.push({
          ...source,
          id,
          name: `${source.name} · 副本`,
          status: 'trial',
          note: '由现有方案复制，准备进行并排试算。',
          createdAt: now,
          updatedAt: now,
          placements: source.placements.map((placement) => ({ ...placement, id: nanoid(10) })),
          reeferPower: source.reeferPower.map((info) => ({ ...info })),
          powerWaitQueue: source.powerWaitQueue.map((entry) => ({ ...entry })),
        });
        state.activePlanId = id;
        state.notice = '已创建试算副本';
      });
    },
    renamePlan(state, action: PayloadAction<{ planId: string; name: string; operationId: string }>) {
      const plan = state.plans.find((candidate) => candidate.id === action.payload.planId);
      if (!plan) return;
      applyOperation(state, action.payload.operationId, 'rename-plan', () => {
        plan.name = action.payload.name.trim() || plan.name;
        plan.updatedAt = new Date().toISOString();
      });
    },
    confirmPlan(state, action: PayloadAction<{ planId: string; operationId: string }>) {
      const plan = state.plans.find((candidate) => candidate.id === action.payload.planId);
      if (!plan) return;
      applyOperation(state, action.payload.operationId, 'confirm-plan', () => {
        pushHistory(state);
        state.plans = state.plans.map((candidate) => ({
          ...candidate,
          status:
            candidate.id === action.payload.planId
              ? 'final'
              : candidate.status === 'final'
                ? 'trial'
                : candidate.status,
        }));
        state.notice = `${plan.name} 已确认为最终配载方案`;
      });
    },
    setBaySockets(
      state,
      action: PayloadAction<{
        bayId: number;
        powerSockets: number;
        powerSocketsOutOfService: number;
        operationId: string;
      }>,
    ) {
      applyOperation(state, action.payload.operationId, 'set-bay-sockets', () => {
        const bay = state.bays.find((candidate) => candidate.id === action.payload.bayId);
        if (!bay) return;
        bay.powerSockets = Math.max(0, Math.floor(action.payload.powerSockets));
        bay.powerSocketsOutOfService = Math.min(
          Math.max(0, Math.floor(action.payload.powerSocketsOutOfService)),
          bay.powerSockets,
        );
        // 插口状态一变，所有方案的冷藏箱占用立即失效重算
        state.plans = recomputeAllReeferPower(state.plans, state.containers, state.ports, state.bays);
        state.notice = `${bay.name} 贝位插口已更新为 ${bay.powerSockets} 个（检修停用 ${bay.powerSocketsOutOfService} 个），冷藏箱占用已重算`;
      });
    },
    setHighlightedConflict(state, action: PayloadAction<string | null>) {
      state.highlightedConflictId = action.payload;
    },
    setNotice(state, action: PayloadAction<string | null>) {
      state.notice = action.payload;
    },
    undo(state, action: PayloadAction<{ operationId: string }>) {
      const previous = state.past.pop();
      if (!previous) return;
      applyOperation(state, action.payload.operationId, 'undo', () => {
        state.future.unshift(clonePlans(state.plans));
        state.plans = previous;
        ensureActivePlan(state);
        state.notice = '已撤销上一步配载调整';
      });
    },
    redo(state, action: PayloadAction<{ operationId: string }>) {
      const next = state.future.shift();
      if (!next) return;
      applyOperation(state, action.payload.operationId, 'redo', () => {
        state.past.push(clonePlans(state.plans));
        state.plans = next;
        ensureActivePlan(state);
        state.notice = '已重做配载调整';
      });
    },
    persistSucceeded(state, action: PayloadAction<{ operationId: string }>) {
      if (state.persist.lastOperationId === action.payload.operationId) {
        state.persist.status = 'saved';
        state.persist.error = null;
        state.persist.savedAt = new Date().toISOString();
      }
      const record = state.operations.find((op) => op.operationId === action.payload.operationId);
      if (record) {
        record.status = 'committed';
        record.error = undefined;
        record.updatedAt = new Date().toISOString();
      }
    },
    persistFailed(state, action: PayloadAction<{ operationId: string; error: string }>) {
      if (state.persist.lastOperationId === action.payload.operationId) {
        state.persist.status = 'failed';
        state.persist.error = action.payload.error;
      }
      const record = state.operations.find((op) => op.operationId === action.payload.operationId);
      if (record) {
        record.status = 'failed';
        record.attempts += 1;
        record.error = action.payload.error;
        record.updatedAt = new Date().toISOString();
      }
    },
    retryPersist(state) {
      // 置回 idle 以触发订阅按操作号重新写盘
      state.persist.status = 'idle';
      state.notice = '正在按操作号重试写入…';
    },
    hydrate(state, action: PayloadAction<Partial<PlannerState>>) {
      const { persist: _persist, operations: _operations, ...rest } = action.payload;
      void _persist;
      void _operations;
      const merged: PlannerState = {
        ...state,
        ...rest,
        past: [],
        future: [],
        operations: Array.isArray(action.payload.operations)
          ? (action.payload.operations as OperationRecord[]).slice(-60)
          : state.operations,
        persist: { status: 'idle', lastOperationId: null, error: null, savedAt: null },
      };
      merged.plans = recomputeAllReeferPower(merged.plans, merged.containers, merged.ports, merged.bays);
      return merged;
    },
  },
});

function activePlan(state: PlannerState): StowagePlan | undefined {
  return state.plans.find((plan) => plan.id === state.activePlanId);
}

/**
 * 所有写操作统一入口：
 * - 按操作号去重，重复提交只认一次（不重复应用副作用）；
 * - 应用后记录操作日志，并置 persist 为待写盘状态。
 */
function applyOperation(
  state: PlannerState,
  operationId: string,
  type: string,
  mutate: () => void,
): void {
  if (state.operations.some((record) => record.operationId === operationId)) {
    state.notice = '该操作号已提交并生效，未重复执行';
    return;
  }
  mutate();
  const now = new Date().toISOString();
  const record: OperationRecord = {
    operationId,
    type,
    status: 'committed',
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  };
  state.operations.push(record);
  if (state.operations.length > 120) state.operations.shift();
  state.persist.status = 'idle';
  state.persist.lastOperationId = operationId;
  state.persist.error = null;
}

function recomputePlanReeferPower(state: PlannerState, plan: StowagePlan): void {
  const result = computeReeferPower(plan.placements, state.containers, state.ports, state.bays);
  const materialized = materializeReeferPower(result);
  plan.reeferPower = mergeReeferPowerInfo(plan.reeferPower, materialized.reeferPower);
  plan.powerWaitQueue = mergePowerWaitQueue(plan.powerWaitQueue, materialized.powerWaitQueue);
}

function recomputeAllReeferPower(
  plans: StowagePlan[],
  containers: PlannerState['containers'],
  ports: PlannerState['ports'],
  bays: Bay[],
): StowagePlan[] {
  return plans.map((plan) => {
    const result = computeReeferPower(plan.placements, containers, ports, bays);
    const materialized = materializeReeferPower(result);
    return {
      ...plan,
      reeferPower: mergeReeferPowerInfo(plan.reeferPower, materialized.reeferPower),
      powerWaitQueue: mergePowerWaitQueue(plan.powerWaitQueue, materialized.powerWaitQueue),
    };
  });
}

function pushHistory(state: PlannerState): void {
  state.past.push(clonePlans(state.plans));
  if (state.past.length > 80) state.past.shift();
  state.future = [];
}

function clonePlans(plans: StowagePlan[]): StowagePlan[] {
  return plans.map((plan) => ({
    ...plan,
    placements: plan.placements.map((placement) => ({ ...placement })),
    reeferPower: plan.reeferPower.map((info) => ({ ...info })),
    powerWaitQueue: plan.powerWaitQueue.map((entry) => ({ ...entry })),
  }));
}

function ensureActivePlan(state: PlannerState): void {
  if (!state.plans.some((plan) => plan.id === state.activePlanId)) {
    state.activePlanId = state.plans[0]?.id ?? '';
  }
}

function isSameSlot(placement: Placement, slot: Slot): boolean {
  return (
    placement.bayId === slot.bayId &&
    placement.row === slot.row &&
    placement.tier === slot.tier
  );
}

export const plannerActions = plannerSlice.actions;
export const plannerReducer = plannerSlice.reducer;

// 供模块级复用的初始状态（main 入口水合时参考）
export { initialState as plannerInitialState };
