import { configureStore } from '@reduxjs/toolkit';
import { plannerReducer, plannerActions } from './plannerSlice';
import { writePlannerToStorage } from '../utils/persistence';

export const store = configureStore({
  reducer: {
    planner: plannerReducer,
  },
});

const AUTO_RETRY_LIMIT = 3;
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleWrite(operationId: string, attempt: number): void {
  if (retryTimers.has(operationId)) return;
  const delay = attempt === 0 ? 300 : 600 * attempt;
  const timer = setTimeout(() => {
    retryTimers.delete(operationId);
    const state = store.getState().planner;
    // 已被更新的操作取代，跳过
    if (state.persist.lastOperationId !== operationId) return;
    const result = writePlannerToStorage(state);
    if (result.ok) {
      store.dispatch(plannerActions.persistSucceeded({ operationId }));
    } else {
      store.dispatch(plannerActions.persistFailed({ operationId, error: result.error ?? '写入失败' }));
      if (attempt + 1 < AUTO_RETRY_LIMIT) {
        scheduleWrite(operationId, attempt + 1);
      }
    }
  }, delay);
  retryTimers.set(operationId, timer);
}

store.subscribe(() => {
  const state = store.getState().planner;
  if (state.persist.status !== 'idle') return;
  const operationId = state.persist.lastOperationId;
  if (!operationId) return;
  scheduleWrite(operationId, 0);
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
