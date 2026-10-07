import { Button, Callout, Dialog, Intent, Tag } from '@blueprintjs/core';
import { useMemo } from 'react';
import type { Container, Port, PowerWaitEntry, StabilityResult } from '../types/shipping';

interface ReleasePrintDialogProps {
  open: boolean;
  planName: string;
  placementsCount: number;
  containers: Container[];
  ports: Port[];
  powerWaitQueue: PowerWaitEntry[];
  pluggedCount: number;
  totalSockets: number;
  stability: StabilityResult;
  onClose: () => void;
  onConfirm: () => void;
}

export function ReleasePrintDialog({
  open,
  planName,
  placementsCount,
  containers,
  ports,
  powerWaitQueue,
  pluggedCount,
  totalSockets,
  stability,
  onClose,
  onConfirm,
}: ReleasePrintDialogProps) {
  const containerMap = useMemo(
    () => new Map(containers.map((container) => [container.id, container])),
    [containers],
  );
  const portMap = useMemo(() => new Map(ports.map((port) => [port.code, port])), [ports]);
  const blocked = powerWaitQueue.length > 0;
  const stabilityOk = stability.status !== 'danger';

  return (
    <Dialog
      isOpen={open}
      onClose={onClose}
      title="放行打印确认"
      icon="print"
      className="release-dialog"
    >
      <div className="dialog-body">
        <p>
          即将打印 <strong>{planName}</strong> 的放行单。当前配载 {placementsCount} 箱，冷藏箱接电{' '}
          {pluggedCount}/{totalSockets}。
        </p>
        <div className="dialog-summary">
          <div>
            <span>平均吃水</span>
            <strong>{stability.meanDraft.toFixed(3)} m</strong>
          </div>
          <div>
            <span>GM</span>
            <strong>{stability.gm.toFixed(3)} m</strong>
          </div>
          <div>
            <span>横倾 / 纵倾</span>
            <strong>
              {stability.heel.toFixed(2)}° / {stability.trim.toFixed(2)} m
            </strong>
          </div>
          <div>
            <span>稳性状态</span>
            <strong>{stabilityOk ? '满足标准' : '存在超限'}</strong>
          </div>
        </div>

        {blocked ? (
          <Callout intent={Intent.DANGER} icon="disable" title="待供电队列未清空，放行打印已拦住">
            仍有 {powerWaitQueue.length} 个冷藏箱未接电，到码头将供不上电。请先调出多余冷藏箱、调修插口或改配到低层格位，清空队列后再放行。
            <ul className="release-dialog__queue">
              {powerWaitQueue.map((entry) => {
                const container = containerMap.get(entry.containerId);
                const port = container ? portMap.get(container.portCode) : undefined;
                return (
                  <li key={entry.containerId}>
                    <Tag minimal intent="danger">
                      {entry.queueOrder}
                    </Tag>
                    {container?.number ?? entry.containerId} · BAY {entry.bayId} · {port?.name ?? '未知港'} ·{' '}
                    {entry.reason === 'high-tier' ? '层位过高' : '插口占满'}
                  </li>
                );
              })}
            </ul>
          </Callout>
        ) : (
          <Callout intent={Intent.SUCCESS} icon="tick-circle" title="冷藏箱已全部接电">
            待供电队列已清空，所有冷藏箱均已接电，可放行打印。
          </Callout>
        )}
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose}>返回调整</Button>
        <Button intent="primary" icon="print" disabled={blocked} onClick={onConfirm}>
          确认放行打印
        </Button>
      </div>
    </Dialog>
  );
}
