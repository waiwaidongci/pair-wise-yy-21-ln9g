import { Button, Callout, Tag } from '@blueprintjs/core';
import { useMemo } from 'react';
import type {
  Bay,
  BayPowerStats,
  Container,
  Port,
  PowerWaitEntry,
  ReeferPowerInfo,
} from '../types/shipping';

interface ReeferPowerPanelProps {
  bays: Bay[];
  containers: Container[];
  ports: Port[];
  reeferPower: ReeferPowerInfo[];
  powerWaitQueue: PowerWaitEntry[];
  onEditBay: (bay: Bay) => void;
  onLocateContainer: (containerId: string) => void;
}

export function ReeferPowerPanel({
  bays,
  containers,
  ports,
  reeferPower,
  powerWaitQueue,
  onEditBay,
  onLocateContainer,
}: ReeferPowerPanelProps) {
  const containerMap = useMemo(
    () => new Map(containers.map((container) => [container.id, container])),
    [containers],
  );
  const portMap = useMemo(() => new Map(ports.map((port) => [port.code, port])), [ports]);

  const bayStats: BayPowerStats[] = useMemo(() => {
    return bays.map((bay) => {
      const infos = reeferPower.filter((info) => info.bayId === bay.id);
      const plugged = infos.filter((info) => info.state === 'plugged').length;
      const total = bay.powerSockets;
      const outOfService = Math.min(Math.max(0, bay.powerSocketsOutOfService), total);
      return {
        bayId: bay.id,
        bayName: bay.name,
        total,
        outOfService: bay.powerSocketsOutOfService,
        available: Math.max(0, total - outOfService),
        plugged,
        queued: infos.length - plugged,
      };
    });
  }, [bays, reeferPower]);

  const totalPlugged = bayStats.reduce((sum, bay) => sum + bay.plugged, 0);
  const totalAvailable = bayStats.reduce((sum, bay) => sum + bay.available, 0);
  const queuedCount = powerWaitQueue.length;

  return (
    <section className="panel power-panel">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">供电插口</span>
          <h2>冷藏箱供电</h2>
        </div>
        <Tag minimal intent={queuedCount ? 'warning' : 'success'}>
          {totalPlugged}/{totalAvailable} 接电 · {queuedCount} 待供电
        </Tag>
      </header>

      <div className="power-bay-list">
        {bayStats.map((stat) => {
          const bay = bays.find((candidate) => candidate.id === stat.bayId);
          const full = stat.plugged >= stat.available;
          return (
            <div key={stat.bayId} className="power-bay-row">
              <div className="power-bay-row__main">
                <strong>BAY {stat.bayName}</strong>
                <span className={full ? 'is-full' : ''}>
                  接电 {stat.plugged}/{stat.available}
                </span>
                {stat.outOfService > 0 && <Tag minimal intent="danger">检修 {stat.outOfService}</Tag>}
              </div>
              <div className="power-bay-row__bar">
                <span
                  className="power-bay-row__used"
                  style={{
                    width: `${stat.available ? Math.min(100, (stat.plugged / stat.available) * 100) : 0}%`,
                  }}
                />
              </div>
              <Button small minimal icon="cog" onClick={() => bay && onEditBay(bay)} />
            </div>
          );
        })}
      </div>

      <div className="power-queue">
        <div className="power-queue__heading">
          <span>待供电队列</span>
          <small>按卸货港先后排队，腾出插口队列头自动补进</small>
        </div>
        {queuedCount === 0 ? (
          <Callout intent="success" icon="tick-circle" compact>
            所有冷藏箱均已接电，待供电队列已清空。
          </Callout>
        ) : (
          <ol className="power-queue__list">
            {powerWaitQueue.map((entry) => {
              const container = containerMap.get(entry.containerId);
              const port = container ? portMap.get(container.portCode) : undefined;
              return (
                <li key={entry.containerId}>
                  <button type="button" onClick={() => onLocateContainer(entry.containerId)}>
                    <span className="power-queue__order">{entry.queueOrder}</span>
                    <span className="power-queue__body">
                      <strong>{container?.number ?? entry.containerId}</strong>
                      <small>
                        BAY {entry.bayId} · {port?.name ?? '未知港'} ·{' '}
                        {entry.reason === 'high-tier' ? '层位过高无插口' : '插口占满'}
                      </small>
                    </span>
                    <Tag minimal intent="warning">待供电</Tag>
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
