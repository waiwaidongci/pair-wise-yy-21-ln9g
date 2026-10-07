import type { PlannerState } from '../types/shipping';

export const STORAGE_KEY = 'pair-wise-yy-21.planner';

export interface PersistedPlanner {
  bays?: unknown;
  plans?: unknown;
  activePlanId?: unknown;
  selectedContainerId?: unknown;
  operations?: unknown;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
}

/** 把需要持久化的状态序列化（不含瞬时 UI 与撤销栈） */
export function serializePlanner(state: PlannerState): PersistedPlanner {
  return {
    bays: state.bays.map((bay) => ({ ...bay })),
    plans: state.plans.map((plan) => ({
      ...plan,
      placements: plan.placements.map((placement) => ({ ...placement })),
      reeferPower: plan.reeferPower.map((info) => ({ ...info })),
      powerWaitQueue: plan.powerWaitQueue.map((entry) => ({ ...entry })),
    })),
    activePlanId: state.activePlanId,
    selectedContainerId: state.selectedContainerId,
    operations: state.operations.slice(-60),
  };
}

export function writePlannerToStorage(state: PlannerState): WriteResult {
  try {
    const payload = JSON.stringify(serializePlanner(state));
    localStorage.setItem(STORAGE_KEY, payload);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadPersistedPlanner(): PersistedPlanner | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedPlanner;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/** 生成操作号（操作号 = 时间戳 + 随机串，用于写盘恢复重试与去重） */
export function createOperationId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `OP-${stamp}-${rand}`;
}
