import '@blueprintjs/core/lib/css/blueprint.css';
import '@blueprintjs/icons/lib/css/blueprint-icons.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { plannerActions } from './stores/plannerSlice';
import { store } from './stores/store';
import { loadPersistedPlanner } from './utils/persistence';
import type { Bay, OperationRecord, StowagePlan } from './types/shipping';
import './styles.css';

const persisted = loadPersistedPlanner();
if (persisted) {
  const hasPlans = Array.isArray(persisted.plans) && persisted.plans.length > 0;
  if (hasPlans) {
    const plans = persisted.plans as StowagePlan[];
    store.dispatch(
      plannerActions.hydrate({
        plans,
        bays: Array.isArray(persisted.bays) ? (persisted.bays as Bay[]) : undefined,
        activePlanId:
          typeof persisted.activePlanId === 'string'
            ? persisted.activePlanId
            : (plans[0] as { id: string }).id,
        selectedContainerId:
          typeof persisted.selectedContainerId === 'string' ? persisted.selectedContainerId : null,
        operations: Array.isArray(persisted.operations)
          ? (persisted.operations as OperationRecord[])
          : [],
      }),
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </React.StrictMode>,
);
