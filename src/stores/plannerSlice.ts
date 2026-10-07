import { createSlice, nanoid } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type {
  Bay,
  HistorySnapshot,
  PlannerState,
  Placement,
  PendingReefer,
  Slot,
  StowagePlan,
} from '../types/shipping';
import { BAYS, CONTAINERS, createInitialPlans, PORTS, VESSEL } from '../utils/mockData';
import { reconcileReeferPower } from '../utils/reeferPower';

const initialPlans = createInitialPlans();

const initialState: PlannerState = {
  vessel: VESSEL,
  ports: PORTS,
  bays: BAYS,
  containers: CONTAINERS,
  plans: initialPlans,
  activePlanId: initialPlans[0].id,
  selectedContainerId: null,
  selectedSlot: null,
  highlightedConflictId: null,
  past: [],
  future: [],
  notice: null,
};

interface OpMeta {
  opId?: string;
}

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
      action: PayloadAction<{ containerId: string; slot: Slot } & OpMeta>,
    ) {
      const plan = activePlan(state);
      if (!plan) return;
      const container = state.containers.find((item) => item.id === action.payload.containerId);
      if (!container) return;
      pushHistory(state);
      // 冷箱旧格位先剔除；其它箱保持原规则（同箱/同位互踢）
      plan.placements = plan.placements.filter((placement) => {
        if (placement.containerId === action.payload.containerId) return false;
        if (isSameSlot(placement, action.payload.slot)) return false;
        return true;
      });
      plan.placements.push({
        ...action.payload.slot,
        id: nanoid(10),
        containerId: action.payload.containerId,
        placedAt: new Date().toISOString(),
      });
      plan.updatedAt = new Date().toISOString();
      state.selectedSlot = action.payload.slot;
      reconcile(state, container.reefer ? '冷藏箱格位已更新，插口占用与待供电队列已重算' : '格位已更新，稳性与隔离规则已重新计算');
    },
    removePlacement(state, action: PayloadAction<string>) {
      const plan = activePlan(state);
      if (!plan) return;
      const removed = plan.placements.find((placement) => placement.id === action.payload);
      const removedContainer = removed
        ? state.containers.find((container) => container.id === removed.containerId)
        : undefined;
      pushHistory(state);
      plan.placements = plan.placements.filter((placement) => placement.id !== action.payload);
      plan.updatedAt = new Date().toISOString();
      reconcile(
        state,
        removedContainer?.reefer
          ? '已移除冷藏箱，腾退插口，待供电队头自动补位'
          : '已从配载图中移除集装箱',
      );
    },
    autoStow(
      state,
      action: PayloadAction<
        { placements: Placement[]; unpoweredReeferIds?: string[] } & OpMeta
      >,
    ) {
      const plan = activePlan(state);
      if (!plan) return;
      pushHistory(state);
      const incomingIds = new Set(action.payload.placements.map((placement) => placement.containerId));
      // 冷箱只能通过供电引擎上插：新配冷箱先全部交给引擎统一排队补位
      plan.placements = [
        ...plan.placements.filter((placement) => !incomingIds.has(placement.containerId)),
        ...action.payload.placements,
      ];
      plan.updatedAt = new Date().toISOString();
      const result = reconcileReeferPower(
        plan,
        state.containers,
        state.bays,
        state.ports,
        action.payload.unpoweredReeferIds?.length
          ? { enqueueCandidates: action.payload.unpoweredReeferIds, idPrefix: 'AUTO-PWR' }
          : { idPrefix: 'AUTO-PWR' },
      );
      plan.placements = result.placements;
      plan.pendingReefers = result.pendingReefers;
      const queued = result.pendingReefers.length;
      state.notice =
        queued > 0
          ? `自动配载已放入 ${action.payload.placements.length} 箱，${queued} 个冷箱插口不足，已按卸货港排队`
          : `自动配载已放入 ${action.payload.placements.length} 个集装箱，冷箱均已接插供电`;
    },
    clearPlan(state) {
      const plan = activePlan(state);
      if (!plan) return;
      pushHistory(state);
      plan.placements = [];
      plan.pendingReefers = [];
      plan.updatedAt = new Date().toISOString();
      state.selectedSlot = null;
      state.notice = '当前方案已清空，所有供电插口已释放，可通过撤销恢复';
    },
    duplicatePlan(state, action: PayloadAction<string>) {
      const source = state.plans.find((plan) => plan.id === action.payload);
      if (!source) return;
      pushHistory(state);
      const id = `PLAN-${nanoid(5).toUpperCase()}`;
      const now = new Date().toISOString();
      const copy: StowagePlan = {
        ...source,
        id,
        name: `${source.name} · 副本`,
        status: 'trial',
        note: '由现有方案复制，准备进行并排试算。',
        createdAt: now,
        updatedAt: now,
        placements: source.placements.map((placement) => ({ ...placement, id: nanoid(10) })),
        pendingReefers: source.pendingReefers.map((item) => ({ ...item })),
      };
      state.plans.push(copy);
      state.activePlanId = id;
      reconcile(state, '已创建试算副本，插口占用与待供电队列已同步重算');
    },
    renamePlan(state, action: PayloadAction<{ planId: string; name: string }>) {
      const plan = state.plans.find((candidate) => candidate.id === action.payload.planId);
      if (!plan) return;
      plan.name = action.payload.name.trim() || plan.name;
      plan.updatedAt = new Date().toISOString();
    },
    confirmPlan(state, action: PayloadAction<string | ({ planId: string } & OpMeta)>) {
      const payload = action.payload;
      const planId = typeof payload === 'string' ? payload : payload.planId;
      const plan = state.plans.find((candidate) => candidate.id === planId);
      if (!plan) return;
      pushHistory(state);
      state.plans = state.plans.map((candidate) => ({
        ...candidate,
        status: candidate.id === planId ? 'final' : candidate.status === 'final' ? 'trial' : candidate.status,
      }));
      state.notice = `${plan.name} 已确认为最终配载方案`;
    },
    /** 调整贝位插口总数或检修停用数；牵连所有方案的供电与稳性结论 */
    setBaySockets(
      state,
      action: PayloadAction<
        { bayId: number; reeferSocketTotal?: number; reeferSocketOutage?: number } & OpMeta
      >,
    ) {
      const bay = state.bays.find((item) => item.id === action.payload.bayId);
      if (!bay) return;
      const nextTotal = clampSocket(action.payload.reeferSocketTotal ?? bay.reeferSocketTotal);
      const nextOutage = Math.min(
        nextTotal,
        Math.max(0, action.payload.reeferSocketOutage ?? bay.reeferSocketOutage),
      );
      if (nextTotal === bay.reeferSocketTotal && nextOutage === bay.reeferSocketOutage) return;
      pushHistory(state);
      bay.reeferSocketTotal = nextTotal;
      bay.reeferSocketOutage = nextOutage;
      const capacity = Math.max(0, nextTotal - nextOutage);
      state.plans.forEach((plan) => {
        const result = reconcileReeferPower(plan, state.containers, state.bays, state.ports, {
          idPrefix: `SOCK-${bay.id}`,
        });
        plan.placements = result.placements;
        plan.pendingReefers = result.pendingReefers;
        plan.updatedAt = new Date().toISOString();
      });
      state.notice = `贝位 ${bay.name} 可用插口调整为 ${capacity} 个，全部方案的冷箱占用已失效重算`;
    },
    setHighlightedConflict(state, action: PayloadAction<string | null>) {
      state.highlightedConflictId = action.payload;
    },
    setNotice(state, action: PayloadAction<string | null>) {
      state.notice = action.payload;
    },
    undo(state) {
      const previous = state.past.pop();
      if (!previous) return;
      state.future.unshift(snapshotState(state));
      restoreState(state, previous);
      ensureActivePlan(state);
      reconcileAllPlans(state, '已撤销上一步配载调整，受影响冷箱与稳性结论已重算');
    },
    redo(state) {
      const next = state.future.shift();
      if (!next) return;
      state.past.push(snapshotState(state));
      restoreState(state, next);
      ensureActivePlan(state);
      reconcileAllPlans(state, '已重做配载调整，受影响冷箱与稳性结论已重算');
    },
    hydrate(state, action: PayloadAction<Partial<PlannerState>>) {
      return {
        ...state,
        ...action.payload,
        plans: normalizeHydratedPlans(state, action.payload.plans),
        bays: normalizeHydratedBays(state, action.payload.bays),
        past: [],
        future: [],
      };
    },
  },
});

function clampSocket(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(200, Math.round(value)));
}

function normalizeHydratedPlans(state: PlannerState, plans: StowagePlan[] | undefined): StowagePlan[] {
  if (!plans) return state.plans;
  return plans.map((plan) => ({
    ...plan,
    pendingReefers: Array.isArray(plan.pendingReefers) ? plan.pendingReefers : [],
  }));
}

function normalizeHydratedBays(state: PlannerState, bays: Bay[] | undefined): Bay[] {
  if (!bays) return state.bays;
  const byId = new Map(bays.map((bay) => [bay.id, bay]));
  return state.bays.map((fallback) => {
    const stored = byId.get(fallback.id);
    if (!stored) return fallback;
    return {
      ...fallback,
      reeferSocketTotal: clampSocket(stored.reeferSocketTotal ?? fallback.reeferSocketTotal),
      reeferSocketOutage: clampSocket(stored.reeferSocketOutage ?? fallback.reeferSocketOutage),
    };
  });
}

/** 对当前活动方案重算供电，并生成结果导向的提示语 */
function reconcile(state: PlannerState, notice: string): void {
  const plan = activePlan(state);
  if (!plan) return;
  const result = reconcileReeferPower(plan, state.containers, state.bays, state.ports);
  plan.placements = result.placements;
  plan.pendingReefers = result.pendingReefers;
  state.notice = notice;
  if (result.evictedContainerIds.length > 0) {
    state.notice += `；${result.evictedContainerIds.length} 个冷箱插口占用失效转入待供电队列`;
  }
  if (result.promotedContainerIds.length > 0) {
    state.notice += `；队头 ${result.promotedContainerIds.length} 个冷箱已自动补进低层格位`;
  }
  if (result.pendingReefers.length > 0) {
    state.notice += `；当前待供电 ${result.pendingReefers.length} 箱`;
  }
}

function reconcileAllPlans(state: PlannerState, notice: string): void {
  state.plans.forEach((plan) => {
    const result = reconcileReeferPower(plan, state.containers, state.bays, state.ports);
    plan.placements = result.placements;
    plan.pendingReefers = result.pendingReefers;
  });
  state.notice = notice;
}

function activePlan(state: PlannerState): StowagePlan | undefined {
  return state.plans.find((plan) => plan.id === state.activePlanId);
}

function pushHistory(state: PlannerState): void {
  state.past.push(snapshotState(state));
  if (state.past.length > 80) state.past.shift();
  state.future = [];
}

function snapshotState(state: PlannerState): HistorySnapshot {
  return {
    plans: clonePlans(state.plans),
    bays: state.bays.map((bay) => ({ ...bay })),
  };
}

function restoreState(state: PlannerState, snapshot: HistorySnapshot): void {
  state.plans = snapshot.plans;
  state.bays = snapshot.bays;
}

function clonePlans(plans: StowagePlan[]): StowagePlan[] {
  return plans.map((plan) => ({
    ...plan,
    placements: plan.placements.map((placement) => ({ ...placement })),
    pendingReefers: plan.pendingReefers.map((item: PendingReefer) => ({ ...item })),
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
