import { configureStore } from '@reduxjs/toolkit';
import { plannerReducer } from './plannerSlice';
import { bindRetryTriggers, createPersistenceMiddleware, saveManager } from './persistence';

const persistenceMiddleware = createPersistenceMiddleware({ manager: saveManager });
bindRetryTriggers(saveManager);

export const store = configureStore({
  reducer: {
    planner: plannerReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({ serializableCheck: false }).concat(persistenceMiddleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
