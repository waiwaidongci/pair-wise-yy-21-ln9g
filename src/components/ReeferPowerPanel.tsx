import { Button, Tag } from '@blueprintjs/core';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Bay, Container, PendingReefer, Placement, Port } from '../types/shipping';
import { baySocketCapacity, computeSocketUsage } from '../utils/reeferPower';

interface ReeferPowerPanelProps {
  bays: Bay[];
  containers: Container[];
  ports: Port[];
  placements: Placement[];
  pendingReefers: PendingReefer[];
  onBaySocketsChange: (payload: {
    bayId: number;
    reeferSocketTotal?: number;
    reeferSocketOutage?: number;
  }) => void;
  onPendingClick: (containerId: string) => void;
}

export function ReeferPowerPanel({
  bays,
  containers,
  ports,
  placements,
  pendingReefers,
  onBaySocketsChange,
  onPendingClick,
}: ReeferPowerPanelProps) {
  const containerMap = useMemo(
    () => new Map(containers.map((container) => [container.id, container])),
    [containers],
  );
  const portMap = useMemo(() => new Map(ports.map((port) => [port.code, port])), [ports]);
  const usage = useMemo(() => computeSocketUsage(placements, containers), [placements, containers]);

  const totalCapacity = bays.reduce((sum, bay) => sum + baySocketCapacity(bay), 0);
  const totalUsed = bays.reduce((sum, bay) => sum + (usage.get(bay.id) ?? 0), 0);

  return (
    <section className="panel power-panel">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">冷藏箱供电</span>
          <h2>插口与待供电队列</h2>
        </div>
        <Tag minimal intent={pendingReefers.length > 0 ? 'danger' : 'success'}>
          {pendingReefers.length} 待供电
        </Tag>
      </header>

      <div className="power-overview">
        <span>
          全船插口 <strong>{totalUsed}/{totalCapacity}</strong> 已占用
        </span>
        <span className={pendingReefers.length > 0 ? 'text-danger' : ''}>
          待供电 <strong>{pendingReefers.length}</strong> 箱
        </span>
      </div>

      <div className="socket-bay-grid">
        {[...bays]
          .sort((a, b) => a.id - b.id)
          .map((bay) => {
            const capacity = baySocketCapacity(bay);
            const used = usage.get(bay.id) ?? 0;
            const tight = used >= capacity;
            return (
              <div key={bay.id} className={`socket-bay ${tight ? 'is-tight' : ''}`}>
                <strong>BAY {bay.name}</strong>
                <label title="插口总数">
                  <span>总数</span>
                  <input
                    type="number"
                    min={0}
                    max={40}
                    value={bay.reeferSocketTotal}
                    onChange={(event) =>
                      onBaySocketsChange({
                        bayId: bay.id,
                        reeferSocketTotal: Number(event.currentTarget.value),
                      })
                    }
                  />
                </label>
                <label title="检修停用">
                  <span>停用</span>
                  <input
                    type="number"
                    min={0}
                    max={bay.reeferSocketTotal}
                    value={bay.reeferSocketOutage}
                    onChange={(event) =>
                      onBaySocketsChange({
                        bayId: bay.id,
                        reeferSocketOutage: Number(event.currentTarget.value),
                      })
                    }
                  />
                </label>
                <span className={`socket-bay__usage ${tight ? 'text-danger' : ''}`}>
                  <i className="bp5-icon bp5-icon-power" />
                  {used}/{capacity}
                </span>
              </div>
            );
          })}
      </div>

      <div className="pending-queue">
        <div className="pending-queue__heading">
          <strong>待供电队列</strong>
          <small>按卸货港先后，插口腾退时队头自动补进低层格位</small>
        </div>
        {pendingReefers.length === 0 ? (
          <div className="pending-queue__empty">
            <i className="bp5-icon bp5-icon-tick-circle" />
            全部冷箱已接插供电，可放行打印
          </div>
        ) : (
          <ol className="pending-queue__list">
            {pendingReefers.map((item, index) => {
              const container = containerMap.get(item.containerId);
              const port = container ? portMap.get(container.portCode) : undefined;
              return (
                <li key={item.containerId}>
                  <button
                    type="button"
                    className="pending-item"
                    onClick={() => onPendingClick(item.containerId)}
                  >
                    <span className="pending-item__rank">{index + 1}</span>
                    <span className="pending-item__main">
                      <strong>{container?.number ?? item.containerId}</strong>
                      <small>
                        {port?.name ?? '未知港'}（{container?.portCode ?? '—'}） · {container?.grossWeight.toFixed(1)} t
                      </small>
                    </span>
                    <Tag minimal intent="danger">待供电</Tag>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

export function gateMessage(pendingCount: number): string | null {
  return pendingCount > 0
    ? `待供电队列尚有 ${pendingCount} 个冷箱，需先腾退插口完成补电后才能放行打印`
    : null;
}

export function DisabledGateButton({
  pendingCount,
  children,
}: {
  pendingCount: number;
  children: ReactNode;
}) {
  const blocked = pendingCount > 0;
  return (
    <Button
      icon={blocked ? 'disable' : 'media'}
      disabled={blocked}
      title={gateMessage(pendingCount) ?? undefined}
    >
      {children}
    </Button>
  );
}
