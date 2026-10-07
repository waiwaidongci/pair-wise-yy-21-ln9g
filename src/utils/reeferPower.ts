import type {
  Bay,
  Container,
  PendingReefer,
  Placement,
  Port,
  Slot,
  StowagePlan,
} from '../types/shipping';

/** 供电重算结果：只有受影响的箱位/队列发生变化，其余沿用原结论 */
export interface ReeferPowerResult {
  /** 重算后的格位（含新补位的冷藏箱） */
  placements: Placement[];
  /** 重算后的待供电队列，已按卸货港先后排序 */
  pendingReefers: PendingReefer[];
  /** 本次受影响（失效重算）的冷箱：淘汰入队 + 补位上插 */
  affectedContainerIds: string[];
  /** 本次被腾退到待供电队列的冷箱 */
  evictedContainerIds: string[];
  /** 本次从队列头补进格位的冷箱 */
  promotedContainerIds: string[];
  /** 各贝位插口占用：bayId -> 占用数 */
  socketUsageByBay: Map<number, number>;
  /** 是否有冷箱状态发生变化 */
  changed: boolean;
}

export interface ReconcileOptions {
  /** 除已有队列外，需要新进入待供电排队的冷箱（如自动配载放不下的冷箱） */
  enqueueCandidates?: string[];
  /** 入队序号起点（持久化计数器），默认在现有最大序号上递增 */
  nextSequence?: number;
  /** 新补位 placement 的 id 前缀 */
  idPrefix?: string;
  now?: string;
}

const REEFER_MAX_TIER = 3;

export function baySocketCapacity(bay: Bay): number {
  return Math.max(0, bay.reeferSocketTotal - bay.reeferSocketOutage);
}

/**
 * 重算一个方案的冷藏箱供电状态。
 *
 * 规则：
 * 1. 每个贝位的可用插口数 = 插口总数 - 检修停用数；
 * 2. 落在该贝位的已供电冷箱占用插口，超出容量时按卸货港靠后者优先淘汰（占用失效）；
 * 3. 被淘汰冷箱和显式入队候选进入待供电队列，队列按卸货港先后、入队序排序；
 * 4. 任意外部状态变化后，队头若能在任意有空插口贝位的低层格位落箱则自动补进；
 * 5. 未受影响的 placement 对象原样沿用，便于稳性/规则增量复用。
 */
export function reconcileReeferPower(
  plan: StowagePlan,
  containers: Container[],
  bays: Bay[],
  ports: Port[],
  options: ReconcileOptions = {},
): ReeferPowerResult {
  const containerMap = new Map(containers.map((container) => [container.id, container]));
  const bayMap = new Map(bays.map((bay) => [bay.id, bay]));
  const capacities = new Map<number, number>(
    bays.map((bay) => [bay.id, baySocketCapacity(bay)]),
  );
  const portSequence = (containerId: string): number => {
    const container = containerMap.get(containerId);
    if (!container) return Number.MAX_SAFE_INTEGER;
    return ports.find((port) => port.code === container.portCode)?.sequence ?? Number.MAX_SAFE_INTEGER;
  };

  // —— 第 1 步：按贝位分组冷箱，超容量时淘汰卸货港靠后者 ——
  const reefersByBay = new Map<number, Placement[]>();
  const unaffectedPlacements: Placement[] = [];
  plan.placements.forEach((placement) => {
    const container = containerMap.get(placement.containerId);
    if (!container || !container.reefer) {
      unaffectedPlacements.push(placement);
      return;
    }
    if (!bayMap.has(placement.bayId)) {
      unaffectedPlacements.push(placement);
      return;
    }
    const list = reefersByBay.get(placement.bayId) ?? [];
    list.push(placement);
    reefersByBay.set(placement.bayId, list);
  });

  const poweredPlacements: Placement[] = [];
  const evictedContainerIds: string[] = [];
  const socketUsageByBay = new Map<number, number>();

  reefersByBay.forEach((list, bayId) => {
    const capacity = capacities.get(bayId) ?? 0;
    // 卸货港在先（sequence 小）的冷箱优先保留插口；被裁掉的即占用失效、转入待供电队列。
    // 同港序时用 id 决胜，保证结果确定且不会无故抖动。
    const ranked = [...list].sort((a, b) =>
      portSequence(a.containerId) - portSequence(b.containerId) || a.id.localeCompare(b.id),
    );
    const keep = new Set<Placement>();
    ranked.slice(0, Math.max(0, Math.min(capacity, list.length))).forEach((placement) => keep.add(placement));
    list.forEach((placement) => {
      if (keep.has(placement)) {
        poweredPlacements.push(placement);
      } else {
        evictedContainerIds.push(placement.containerId);
      }
    });
    socketUsageByBay.set(bayId, keep.size);
  });

  // —— 第 2 步：合并待供电队列（淘汰 + 显式候选），补全序号后排序 ——
  // 已经落回格位的冷箱不再属于队列（覆盖水合旧数据等场景）
  const placedReeferIds = new Set<string>();
  reefersByBay.forEach((list) => list.forEach((placement) => placedReeferIds.add(placement.containerId)));
  let sequence =
    options.nextSequence ??
    plan.pendingReefers.reduce((max, item) => Math.max(max, item.enqueuedAt), 0) + 1;
  const pending: PendingReefer[] = plan.pendingReefers
    .filter((item) => !placedReeferIds.has(item.containerId))
    .map((item) => ({ ...item }));
  const enqueue = (containerId: string) => {
    if (pending.some((item) => item.containerId === containerId)) return;
    const container = containerMap.get(containerId);
    if (!container || !container.reefer) return;
    const item = { containerId, enqueuedAt: sequence };
    sequence += 1;
    pending.push(item);
  };
  evictedContainerIds.forEach(enqueue);
  (options.enqueueCandidates ?? []).forEach(enqueue);
  pending.sort(
    (a, b) =>
      portSequence(a.containerId) - portSequence(b.containerId) || a.enqueuedAt - b.enqueuedAt,
  );

  // —— 第 3 步：队头自动补进——逐行扫描队列，能落箱就补 ——
  // 被淘汰冷箱的原格位随其从 placements 移除，occupied 按保留箱重建
  const occupied = new Set(
    [...unaffectedPlacements, ...poweredPlacements].map(
      (placement) => `${placement.bayId}:${placement.row}:${placement.tier}`,
    ),
  );

  const promotedContainerIds: string[] = [];
  const promotedPlacements: Placement[] = [];
  const now = options.now ?? new Date().toISOString();
  let autoIndex = 0;
  const remainingPending: PendingReefer[] = [];

  for (const item of pending) {
    const container = containerMap.get(item.containerId);
    if (!container) continue;
    const slot = findPoweredSlot(container, bays, capacities, socketUsageByBay, occupied, [
      ...unaffectedPlacements,
      ...poweredPlacements,
      ...promotedPlacements,
    ]);
    if (slot) {
      occupied.add(`${slot.bayId}:${slot.row}:${slot.tier}`);
      socketUsageByBay.set(slot.bayId, (socketUsageByBay.get(slot.bayId) ?? 0) + 1);
      promotedPlacements.push({
        ...slot,
        id: `${options.idPrefix ?? 'PWR'}-${item.enqueuedAt}-${autoIndex}`,
        containerId: item.containerId,
        placedAt: now,
      });
      autoIndex += 1;
      promotedContainerIds.push(item.containerId);
    } else {
      remainingPending.push(item);
    }
  }

  const nextPlacements = [...unaffectedPlacements, ...poweredPlacements, ...promotedPlacements];
  const affectedContainerIds = [...evictedContainerIds, ...promotedContainerIds];

  return {
    placements: nextPlacements,
    pendingReefers: remainingPending,
    affectedContainerIds,
    evictedContainerIds,
    promotedContainerIds,
    socketUsageByBay,
    changed:
      affectedContainerIds.length > 0 ||
      nextPlacements.length !== plan.placements.length ||
      remainingPending.length !== plan.pendingReefers.length,
  };
}

/**
 * 为冷箱寻找一个「有空插口贝位 + 低层（1—3 层）」的空格位。
 * 贝位按可用插口余量、纵向居中程度排序；格位自低向高、自内向外扫描，
 * 并复用配载规则里的危品隔离检查。
 */
export function findPoweredSlot(
  container: Container,
  bays: Bay[],
  capacities: Map<number, number>,
  socketUsage: Map<number, number>,
  occupied: Set<string>,
  assigned: Placement[],
): Slot | null {
  const eligibleBays = bays
    .filter((bay) => (socketUsage.get(bay.id) ?? 0) < (capacities.get(bay.id) ?? 0))
    .sort(
      (a, b) =>
        (capacities.get(b.id)! - (socketUsage.get(b.id) ?? 0)) -
          (capacities.get(a.id)! - (socketUsage.get(a.id) ?? 0)) ||
        Math.abs(a.longitudinalPosition) - Math.abs(b.longitudinalPosition),
    );
  for (const bay of eligibleBays) {
    for (let tier = 1; tier <= Math.min(REEFER_MAX_TIER, bay.tiers); tier += 1) {
      for (let row = 1; row <= bay.rows; row += 1) {
        const key = `${bay.id}:${row}:${tier}`;
        if (occupied.has(key)) continue;
        if (tier > 1 && !occupied.has(`${bay.id}:${row}:${tier - 1}`)) continue;
        if (!isSegregationCompatible(container, bay.id, row, tier, assigned)) continue;
        return { bayId: bay.id, row, tier };
      }
    }
  }
  return null;
}

function isSegregationCompatible(
  container: Container,
  bayId: number,
  row: number,
  tier: number,
  assigned: Placement[],
): boolean {
  if (container.hazardClass === 'none') return true;
  return !assigned.some((placement) => {
    if (Math.abs(placement.bayId - bayId) + Math.abs(placement.row - row) > 3) return false;
    return Math.abs(placement.tier - tier) <= 2;
  });
}

/** 计算每个贝位当前冷箱插口占用（不依赖队列，仅按落箱冷箱统计） */
export function computeSocketUsage(placements: Placement[], containers: Container[]): Map<number, number> {
  const containerMap = new Map(containers.map((container) => [container.id, container]));
  const usage = new Map<number, number>();
  placements.forEach((placement) => {
    if (containerMap.get(placement.containerId)?.reefer) {
      usage.set(placement.bayId, (usage.get(placement.bayId) ?? 0) + 1);
    }
  });
  return usage;
}
