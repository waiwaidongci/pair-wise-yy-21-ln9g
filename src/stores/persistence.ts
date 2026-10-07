import type { Middleware, MiddlewareAPI } from '@reduxjs/toolkit';
import { plannerActions } from './plannerSlice';
import type { PlannerState } from '../types/shipping';

const STATE_KEY = 'pair-wise-yy-21.planner';
/** 已应用操作号台账（跨会话持久，负责"重复提交只认一次"） */
const JOURNAL_KEY = 'pair-wise-yy-21.planner.ops';
const JOURNAL_LIMIT = 500;

export type SavePhase = 'idle' | 'saving' | 'saved' | 'retrying' | 'error';

export interface SaveSnapshot {
  phase: SavePhase;
  /** 当前待写盘/重试中的操作号 */
  pendingOpId: string | null;
  /** 最近一次写盘成功对应的操作号 */
  lastSavedOpId: string | null;
  /** 已失败的重试次数（用于提示） */
  attempts: number;
  error: string | null;
  /** 最近一次写盘成功时间（毫秒时间戳） */
  savedAt: number | null;
}

type Listener = (snapshot: SaveSnapshot) => void;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SaveManagerOptions {
  storage?: StorageLike;
  /** 注入写盘失败（测试用）：返回 true 时本次 setItem 抛错 */
  shouldFail?: () => boolean;
  /** 失败后的退避毫秒序列，默认 500 / 1500 / 4000 */
  backoffMs?: number[];
  now?: () => number;
}

interface JournalState {
  /** 已应用（reducer 执行过）的操作号，按时间顺序保留 */
  applied: string[];
  /** 最近一次成功写盘对应的操作号 */
  lastSavedOpId: string | null;
}

/**
 * 写盘管理器：
 * - 所有修改类操作携带单调递增的操作号 opId；
 * - 同一 opId 的重复提交在中间件层直接丢弃，reducer 只执行一次；
 * - 写盘失败保留"最后一次未写盘的状态 + 操作号"，按退避序列重试，
 *   重试始终围绕该操作号，直到成功后才推进；
 * - 重新可见页面 / 重新上线时立即补一次重试。
 */
export class SaveManager {
  private storage: StorageLike;
  private shouldFail: () => boolean;
  private backoffMs: number[];
  private now: () => number;

  private counter = 0;
  private applied: Set<string>;
  private appliedOrder: string[] = [];
  private lastSavedOpId: string | null;

  private pendingOpId: string | null = null;
  private pendingState: PlannerState | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private error: string | null = null;
  private listeners = new Set<Listener>();

  constructor(options: SaveManagerOptions = {}) {
    this.storage = options.storage ?? safeLocalStorage();
    this.shouldFail = options.shouldFail ?? (() => false);
    this.backoffMs = options.backoffMs ?? [500, 1500, 4000];
    this.now = options.now ?? Date.now;
    const journal = this.readJournal();
    this.applied = new Set(journal.applied);
    this.appliedOrder = [...journal.applied];
    this.lastSavedOpId = journal.lastSavedOpId;
  }

  nextOpId(): string {
    this.counter += 1;
    return `OP-${this.now().toString(36).toUpperCase()}-${this.counter}`;
  }

  /** 操作号是否已经应用过（重复提交判定） */
  isApplied(opId: string): boolean {
    return this.applied.has(opId);
  }

  markApplied(opId: string): void {
    if (this.applied.has(opId)) return;
    this.applied.add(opId);
    this.appliedOrder.push(opId);
    if (this.appliedOrder.length > JOURNAL_LIMIT) {
      const dropped = this.appliedOrder.splice(0, this.appliedOrder.length - JOURNAL_LIMIT);
      dropped.forEach((id) => this.applied.delete(id));
    }
  }

  /** 安排一次（去抖）写盘 */
  schedule(opId: string, state: PlannerState): void {
    this.pendingOpId = opId;
    this.pendingState = state;
    this.attempts = 0;
    this.error = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, 300);
    this.emit('saving');
  }

  /** 立即尝试把挂起的状态按操作号写盘 */
  async flush(): Promise<boolean> {
    if (!this.pendingState || !this.pendingOpId) return true;
    const opId = this.pendingOpId;
    const state = this.pendingState;
    try {
      if (this.shouldFail()) throw new Error('模拟写盘失败');
      const persisted = { ...serializeState(state), lastOpId: opId };
      this.storage.setItem(STATE_KEY, JSON.stringify(persisted));
      this.lastSavedOpId = opId;
      this.writeJournal();
      this.pendingOpId = null;
      this.pendingState = null;
      this.attempts = 0;
      this.error = null;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.emit('saved');
      return true;
    } catch (caught) {
      this.attempts += 1;
      this.error = caught instanceof Error ? caught.message : String(caught);
      const delay = this.backoffMs[Math.min(this.attempts - 1, this.backoffMs.length - 1)];
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.flush();
      }, delay);
      this.emit('retrying');
      return false;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): SaveSnapshot {
    const phase: SavePhase = this.pendingOpId
      ? this.error
        ? 'retrying'
        : 'saving'
      : this.lastSavedOpId
        ? 'saved'
        : 'idle';
    return {
      phase,
      pendingOpId: this.pendingOpId,
      lastSavedOpId: this.lastSavedOpId,
      attempts: this.attempts,
      error: this.error,
      savedAt: this.lastSavedOpId ? this.now() : null,
    };
  }

  private emit(phase: SavePhase): void {
    const snapshot = { ...this.snapshot(), phase };
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private readJournal(): JournalState {
    try {
      const raw = this.storage.getItem(JOURNAL_KEY);
      if (!raw) return { applied: [], lastSavedOpId: null };
      const parsed = JSON.parse(raw) as JournalState;
      return {
        applied: Array.isArray(parsed.applied) ? parsed.applied : [],
        lastSavedOpId: typeof parsed.lastSavedOpId === 'string' ? parsed.lastSavedOpId : null,
      };
    } catch {
      return { applied: [], lastSavedOpId: null };
    }
  }

  private writeJournal(): void {
    const journal: JournalState = { applied: this.appliedOrder, lastSavedOpId: this.lastSavedOpId };
    this.storage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  }
}

function serializeState(state: PlannerState) {
  return {
    plans: state.plans,
    activePlanId: state.activePlanId,
    selectedContainerId: state.selectedContainerId,
    bays: state.bays,
  };
}

function safeLocalStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* fall through */
  }
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  };
}

/** 只有这些 action 属于"修改配载数据"的操作，需要操作号与写盘 */
const MUTATING_SUFFIXES = [
  plannerActions.assignContainer.type,
  plannerActions.removePlacement.type,
  plannerActions.autoStow.type,
  plannerActions.clearPlan.type,
  plannerActions.duplicatePlan.type,
  plannerActions.renamePlan.type,
  plannerActions.confirmPlan.type,
  plannerActions.setBaySockets.type,
  plannerActions.undo.type,
  plannerActions.redo.type,
];

function isMutating(action: { type: string }): boolean {
  return (MUTATING_SUFFIXES as string[]).includes(action.type);
}

export interface PersistenceMiddlewareOptions {
  manager: SaveManager;
}

/**
 * 中间件职责：
 * 1. 为修改类操作分配/校验操作号，重复提交只放行第一次；
 * 2. 状态落 reducer 后交给 SaveManager 按操作号写盘与失败重试。
 */
export function createPersistenceMiddleware(options: PersistenceMiddlewareOptions): Middleware {
  const { manager } = options;
  return ((api: MiddlewareAPI) =>
    (next) =>
    (action: { type: string; payload?: { opId?: string } }) => {
      if (!isMutating(action)) {
        return next(action);
      }
      let opId = action.payload?.opId;
      if (opId && manager.isApplied(opId)) {
        // 重复提交：同一操作号只认第一次
        return api.getState();
      }
      if (!opId) opId = manager.nextOpId();
      const actionWithOp = {
        ...action,
        payload: { ...(action.payload ?? {}), opId },
      };
      const result = next(actionWithOp);
      manager.markApplied(opId);
      const state = (api.getState() as { planner: PlannerState }).planner;
      manager.schedule(opId, state);
      return result;
    }) as Middleware;
}

/** React 友好的单例管理器（main.tsx 装配） */
export const saveManager = new SaveManager();

/** 页面重新可见或重新联网时立即补重试盘 */
export function bindRetryTriggers(manager: SaveManager = saveManager): void {
  const kick = () => {
    void manager.flush();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
  }
}
