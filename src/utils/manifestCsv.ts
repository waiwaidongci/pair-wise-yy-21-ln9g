import type {
  Bay,
  Container,
  PendingReefer,
  Placement,
  Port,
  StowagePlan,
  StabilityResult,
} from '../types/shipping';
import { baySocketCapacity } from './reeferPower';

export interface ManifestPowerData {
  bays: Bay[];
  pendingReefers: PendingReefer[];
}

/** 生成配载清单 CSV（纯函数，便于测试；文档下载器复用同一内容） */
export function buildManifestCsv(
  plan: StowagePlan,
  containers: Container[],
  ports: Port[],
  stability: StabilityResult,
  power: ManifestPowerData,
): string {
  const containerMap = new Map(containers.map((container) => [container.id, container]));
  const portMap = new Map(ports.map((port) => [port.code, port]));
  const rows = plan.placements
    .map((placement) => ({
      placement,
      container: containerMap.get(placement.containerId),
      port: portMap.get(containerMap.get(placement.containerId)?.portCode ?? ''),
    }))
    .filter((row) => row.container)
    .sort(
      (a, b) =>
        a.placement.bayId - b.placement.bayId ||
        a.placement.row - b.placement.row ||
        a.placement.tier - b.placement.tier,
    );
  const socketUsage = new Map<number, number>();
  rows.forEach(({ placement, container }) => {
    if (container?.reefer) {
      socketUsage.set(placement.bayId, (socketUsage.get(placement.bayId) ?? 0) + 1);
    }
  });

  const header = [
    '贝位',
    '排号',
    '层号',
    '箱号',
    '箱型',
    '总重(t)',
    '目的港',
    '危险品等级',
    'UN编号',
    '货物',
    '冷藏',
    '插口状态',
  ];
  const csvRows = rows.map(({ placement, container, port }) => {
    const isReefer = container!.reefer;
    const bay = power.bays.find((item) => item.id === placement.bayId);
    const capacity = bay ? baySocketCapacity(bay) : 0;
    const used = socketUsage.get(placement.bayId) ?? 0;
    return [
      placement.bayId,
      placement.row,
      placement.tier,
      container!.number,
      container!.type,
      container!.grossWeight.toFixed(2),
      `${port?.name ?? ''}(${container!.portCode})`,
      container!.hazardClass === 'none' ? '普货' : container!.hazardClass,
      container!.unNumber ?? '',
      container!.cargo,
      isReefer ? '冷藏箱' : '',
      isReefer ? `已供电（${used}/${capacity}）` : '—',
    ];
  });

  const socketSection: (string | number)[][] = [
    [],
    ['贝位供电插口统计'],
    ['贝位', '插口总数', '检修停用', '可用插口', '已占用', '空闲插口'],
    ...[...power.bays]
      .sort((a, b) => a.id - b.id)
      .map((bay) => {
        const capacity = baySocketCapacity(bay);
        const used = socketUsage.get(bay.id) ?? 0;
        return [bay.name, bay.reeferSocketTotal, bay.reeferSocketOutage, capacity, used, Math.max(0, capacity - used)];
      }),
  ];

  const pendingSection: (string | number)[][] = [
    [],
    ['待供电冷藏箱明细（按卸货港先后排队）'],
    ['排队序号', '箱号', '箱型', '目的港', '总重(t)', '入队序号'],
    ...power.pendingReefers.map((item, index) => {
      const container = containerMap.get(item.containerId);
      const port = container ? portMap.get(container.portCode) : undefined;
      return [
        index + 1,
        container?.number ?? item.containerId,
        container?.type ?? '',
        port ? `${port.name}(${container!.portCode})` : '',
        container?.grossWeight.toFixed(2) ?? '',
        item.enqueuedAt,
      ];
    }),
    ...(power.pendingReefers.length === 0 ? [['—', '无待供电冷箱，插口容量满足全部冷箱', '', '', '', '']] : []),
  ];

  const summary = [
    [],
    ['方案', plan.name],
    ['状态', plan.status === 'final' ? '已确认' : '试算'],
    ['总箱量', plan.placements.length],
    ['待供电冷箱', power.pendingReefers.length],
    ['货物重量(t)', stability.loadWeight.toFixed(2)],
    ['平均吃水(m)', stability.meanDraft.toFixed(3)],
    ['首吃水(m)', stability.draftFore.toFixed(3)],
    ['尾吃水(m)', stability.draftAft.toFixed(3)],
    ['纵倾(m)', stability.trim.toFixed(3)],
    ['横倾(°)', stability.heel.toFixed(3)],
    ['GM(m)', stability.gm.toFixed(3)],
  ];
  return [header, ...csvRows, ...socketSection, ...pendingSection, ...summary]
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    .join('\n');
}
