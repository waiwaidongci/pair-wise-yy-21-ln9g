import type {
  Bay,
  Container,
  Port,
  PowerWaitEntry,
  ReeferPowerInfo,
  StowagePlan,
  StabilityResult,
} from '../types/shipping';

export function downloadPlanPng(canvas: HTMLCanvasElement, plan: StowagePlan): void {
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `${plan.name.replaceAll(' ', '_')}_配载图.png`;
  link.click();
}

export function downloadManifest(
  plan: StowagePlan,
  containers: Container[],
  ports: Port[],
  stability: StabilityResult,
  bays: Bay[],
  reeferPower: ReeferPowerInfo[],
  powerWaitQueue: PowerWaitEntry[],
): void {
  const containerMap = new Map(containers.map((container) => [container.id, container]));
  const portMap = new Map(ports.map((port) => [port.code, port]));
  const powerMap = new Map(reeferPower.map((info) => [info.containerId, info]));
  const rows = plan.placements
    .map((placement) => {
      const container = containerMap.get(placement.containerId);
      const port = container ? portMap.get(container.portCode) : undefined;
      const power = container?.reefer ? powerMap.get(container.id) : undefined;
      return { placement, container, port, power };
    })
    .filter((row) => row.container)
    .sort(
      (a, b) =>
        a.placement.bayId - b.placement.bayId ||
        a.placement.row - b.placement.row ||
        a.placement.tier - b.placement.tier,
    );
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
    '供电状态',
    '待供电队列号',
  ];
  const csvRows = rows.map(({ placement, container, port, power }) => [
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
    power ? (power.state === 'plugged' ? '已接电' : '待供电') : '',
    power?.queueOrder ? String(power.queueOrder) : '',
  ]);

  const bayStats = bays.map((bay) => {
    const infos = reeferPower.filter((info) => info.bayId === bay.id);
    const plugged = infos.filter((info) => info.state === 'plugged').length;
    const available = Math.max(0, bay.powerSockets - bay.powerSocketsOutOfService);
    return { bay, plugged, available, queued: infos.length - plugged };
  });
  const totalPlugged = bayStats.reduce((sum, item) => sum + item.plugged, 0);
  const totalAvailable = bayStats.reduce((sum, item) => sum + item.available, 0);

  const summary: (string | number)[][] = [
    [],
    ['方案', plan.name],
    ['状态', plan.status === 'final' ? '已确认' : '试算'],
    ['总箱量', plan.placements.length],
    ['货物重量(t)', stability.loadWeight.toFixed(2)],
    ['平均吃水(m)', stability.meanDraft.toFixed(3)],
    ['首吃水(m)', stability.draftFore.toFixed(3)],
    ['尾吃水(m)', stability.draftAft.toFixed(3)],
    ['纵倾(m)', stability.trim.toFixed(3)],
    ['横倾(°)', stability.heel.toFixed(3)],
    ['GM(m)', stability.gm.toFixed(3)],
    [],
    ['插口占用', `接电 ${totalPlugged}/${totalAvailable}`],
    ...bayStats.map(({ bay, plugged, available, queued }) => [
      `  BAY ${bay.name}`,
      `接电 ${plugged}/${available}${bay.powerSocketsOutOfService > 0 ? `（检修 ${bay.powerSocketsOutOfService}）` : ''}${queued > 0 ? `，待供电 ${queued}` : ''}`,
    ]),
    [],
    [`待供电队列（${powerWaitQueue.length}）`],
    ...powerWaitQueue.map((entry) => {
      const container = containerMap.get(entry.containerId);
      const port = container ? portMap.get(container.portCode) : undefined;
      return [
        `  ${entry.queueOrder}`,
        container?.number ?? entry.containerId,
        `BAY ${entry.bayId}`,
        port?.name ?? '',
        entry.reason === 'high-tier' ? '层位过高无插口' : '插口占满',
      ];
    }),
  ];
  const csv = [header, ...csvRows, ...summary]
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${plan.name.replaceAll(' ', '_')}_配载清单.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
