import type {
  Bay,
  BayPowerStats,
  Container,
  Placement,
  Port,
  PowerWaitEntry,
  ReeferPowerInfo,
  ReeferPowerState,
} from '../types/shipping';

/** 冷藏箱可接电的最高层位（低层格位才有插口与检修通道） */
export const REEFER_LOW_TIER_MAX = 3;

export interface ReeferPowerResult {
  infoByContainer: Map<string, ReeferPowerInfo>;
  queue: PowerWaitEntry[];
  bayStats: BayPowerStats[];
}

interface ReeferPlacement {
  placement: Placement;
  container: Container;
}

/**
 * 按贝位分配供电插口：
 * - 冷藏箱落在低层格位（≤3 层）且贝位有可用插口才算「已接电」；
 * - 插口不够时按卸货港先后（港序升序）排队，腾出插口后队列头自动补进；
 * - 高层冷藏箱（>3 层）无插口可用，进入待供电队列，需改配到低层。
 *
 * 纯函数：箱位或插口状态一变，重算即得到新结论；调用方负责与旧结论合并，
 * 引用未变的条目沿用原结论。
 */
export function computeReeferPower(
  placements: Placement[],
  containers: Container[],
  ports: Port[],
  bays: Bay[],
): ReeferPowerResult {
  const containerMap = new Map(containers.map((container) => [container.id, container]));
  const portSeqMap = new Map(ports.map((port) => [port.code, port.sequence]));
  const placedAtMap = new Map(placements.map((placement) => [placement.containerId, placement.placedAt]));
  const infoByContainer = new Map<string, ReeferPowerInfo>();
  const queue: PowerWaitEntry[] = [];
  const bayStats: BayPowerStats[] = [];

  const reefersByBay = new Map<number, ReeferPlacement[]>();
  for (const placement of placements) {
    const container = containerMap.get(placement.containerId);
    if (!container || !container.reefer) continue;
    const list = reefersByBay.get(placement.bayId) ?? [];
    list.push({ placement, container });
    reefersByBay.set(placement.bayId, list);
  }

  const prioritySort = (a: ReeferPlacement, b: ReeferPlacement): number => {
    const seqA = portSeqMap.get(a.container.portCode) ?? 99;
    const seqB = portSeqMap.get(b.container.portCode) ?? 99;
    if (seqA !== seqB) return seqA - seqB;
    if (a.placement.tier !== b.placement.tier) return a.placement.tier - b.placement.tier;
    const placedAtA = placedAtMap.get(a.container.id) ?? '';
    const placedAtB = placedAtMap.get(b.container.id) ?? '';
    if (placedAtA !== placedAtB) return placedAtA.localeCompare(placedAtB);
    return a.container.id.localeCompare(b.container.id);
  };

  for (const bay of bays) {
    const total = bay.powerSockets;
    const outOfService = Math.min(Math.max(0, bay.powerSocketsOutOfService), total);
    const available = Math.max(0, total - outOfService);
    const list = reefersByBay.get(bay.id) ?? [];
    const lowTier = list.filter(({ placement }) => placement.tier <= REEFER_LOW_TIER_MAX);
    const highTier = list.filter(({ placement }) => placement.tier > REEFER_LOW_TIER_MAX);
    lowTier.sort(prioritySort);
    highTier.sort(prioritySort);

    let plugged = 0;
    lowTier.forEach((item, index) => {
      const hasSocket = index < available;
      const state: ReeferPowerState = hasSocket ? 'plugged' : 'queued';
      if (hasSocket) plugged += 1;
      infoByContainer.set(item.container.id, {
        containerId: item.container.id,
        bayId: bay.id,
        row: item.placement.row,
        tier: item.placement.tier,
        state,
        reason: hasSocket ? 'ok' : 'sockets-full',
        queueOrder: null,
        portSequence: portSeqMap.get(item.container.portCode) ?? 99,
      });
    });

    for (const item of highTier) {
      infoByContainer.set(item.container.id, {
        containerId: item.container.id,
        bayId: bay.id,
        row: item.placement.row,
        tier: item.placement.tier,
        state: 'queued',
        reason: 'high-tier',
        queueOrder: null,
        portSequence: portSeqMap.get(item.container.portCode) ?? 99,
      });
    }

    bayStats.push({
      bayId: bay.id,
      bayName: bay.name,
      total,
      outOfService: bay.powerSocketsOutOfService,
      available,
      plugged,
      queued: list.length - plugged,
    });
  }

  const queuedInfos = [...infoByContainer.values()].filter((info) => info.state === 'queued');
  queuedInfos.sort((a, b) => {
    if (a.portSequence !== b.portSequence) return a.portSequence - b.portSequence;
    const placedAtA = placedAtMap.get(a.containerId) ?? '';
    const placedAtB = placedAtMap.get(b.containerId) ?? '';
    if (placedAtA !== placedAtB) return placedAtA.localeCompare(placedAtB);
    return a.containerId.localeCompare(b.containerId);
  });
  queuedInfos.forEach((info, index) => {
    const order = index + 1;
    info.queueOrder = order;
    queue.push({
      containerId: info.containerId,
      bayId: info.bayId,
      portSequence: info.portSequence,
      queueOrder: order,
      reason: info.reason === 'ok' ? 'sockets-full' : info.reason,
    });
  });

  return { infoByContainer, queue, bayStats };
}

export function materializeReeferPower(result: ReeferPowerResult): {
  reeferPower: ReeferPowerInfo[];
  powerWaitQueue: PowerWaitEntry[];
} {
  return {
    reeferPower: [...result.infoByContainer.values()],
    powerWaitQueue: result.queue,
  };
}

export function reeferPowerForContainer(
  result: ReeferPowerResult,
  containerId: string,
): ReeferPowerInfo | undefined {
  return result.infoByContainer.get(containerId);
}

/** 合并新旧结论：关键字段未变的条目沿用原引用（其余箱沿用原结论） */
export function mergeReeferPowerInfo(
  prev: ReeferPowerInfo[],
  next: ReeferPowerInfo[],
): ReeferPowerInfo[] {
  const prevMap = new Map(prev.map((info) => [info.containerId, info]));
  return next.map((info) => {
    const old = prevMap.get(info.containerId);
    if (
      old &&
      old.state === info.state &&
      old.reason === info.reason &&
      old.queueOrder === info.queueOrder &&
      old.bayId === info.bayId &&
      old.row === info.row &&
      old.tier === info.tier
    ) {
      return old;
    }
    return info;
  });
}

export function mergePowerWaitQueue(prev: PowerWaitEntry[], next: PowerWaitEntry[]): PowerWaitEntry[] {
  const prevMap = new Map(prev.map((entry) => [entry.containerId, entry]));
  return next.map((entry) => {
    const old = prevMap.get(entry.containerId);
    if (
      old &&
      old.queueOrder === entry.queueOrder &&
      old.reason === entry.reason &&
      old.bayId === entry.bayId
    ) {
      return old;
    }
    return entry;
  });
}
