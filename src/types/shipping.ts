export type ContainerType = '20GP' | '40GP' | '40HQ' | '20RF';
export type HazardClass = 'none' | '1.1' | '2.1' | '3' | '4.1' | '5.1' | '6.1' | '8';
export type PlanStatus = 'trial' | 'final';

export interface Port {
  code: string;
  name: string;
  country: string;
  sequence: number;
  color: string;
}

export interface Container {
  id: string;
  number: string;
  type: ContainerType;
  grossWeight: number;
  tareWeight: number;
  payload: number;
  portCode: string;
  hazardClass: HazardClass;
  unNumber?: string;
  reefer: boolean;
  cargo: string;
}

export interface Bay {
  id: number;
  name: string;
  longitudinalPosition: number;
  rows: number;
  tiers: number;
  maxStackWeight: number;
  /** 贝位供电插口总数 */
  powerSockets: number;
  /** 检修停用的插口数 */
  powerSocketsOutOfService: number;
}

export interface Slot {
  bayId: number;
  row: number;
  tier: number;
}

export interface Placement extends Slot {
  id: string;
  containerId: string;
  placedAt: string;
}

/** 冷藏箱接电状态：已接电 / 待供电 */
export type ReeferPowerState = 'plugged' | 'queued';
/** 待供电原因：插口占满 / 层位过高无插口 */
export type ReeferPowerReason = 'ok' | 'sockets-full' | 'high-tier';

/** 单个冷藏箱的供电结论（随箱位与插口状态失效重算） */
export interface ReeferPowerInfo {
  containerId: string;
  bayId: number;
  row: number;
  tier: number;
  state: ReeferPowerState;
  reason: ReeferPowerReason;
  /** 待供电队列序号（从 1 开始），已接电为 null */
  queueOrder: number | null;
  /** 卸货港序，决定排队先后 */
  portSequence: number;
}

/** 待供电队列条目 */
export interface PowerWaitEntry {
  containerId: string;
  bayId: number;
  portSequence: number;
  queueOrder: number;
  reason: ReeferPowerReason;
}

/** 贝位插口占用统计 */
export interface BayPowerStats {
  bayId: number;
  bayName: string;
  total: number;
  outOfService: number;
  available: number;
  plugged: number;
  queued: number;
}

/** 操作记录状态：已生效 / 写盘失败 */
export type OperationStatus = 'committed' | 'failed';

/** 按操作号记录的写操作，用于失败恢复重试与重复提交去重 */
export interface OperationRecord {
  operationId: string;
  type: string;
  status: OperationStatus;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 写盘持久化状态 */
export interface PersistState {
  status: 'idle' | 'saved' | 'failed';
  lastOperationId: string | null;
  error: string | null;
  savedAt: string | null;
}

export interface StowagePlan {
  id: string;
  name: string;
  status: PlanStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
  placements: Placement[];
  /** 冷藏箱供电结论（缓存，箱位或插口变化时失效重算） */
  reeferPower: ReeferPowerInfo[];
  /** 待供电队列（按卸货港先后排序） */
  powerWaitQueue: PowerWaitEntry[];
}

export interface VesselSpec {
  name: string;
  imo: string;
  voyage: string;
  flag: string;
  lengthOverall: number;
  breadth: number;
  lightshipWeight: number;
  lightshipLcg: number;
  lightshipVcg: number;
  maxDraft: number;
  minDraft: number;
  maxTrim: number;
  maxHeel: number;
  minGm: number;
  hydrostaticTable: HydrostaticRow[];
}

export interface HydrostaticRow {
  draft: number;
  displacement: number;
  km: number;
  lcb: number;
  mct: number;
}

export interface StabilityResult {
  displacement: number;
  loadWeight: number;
  meanDraft: number;
  draftFore: number;
  draftAft: number;
  trim: number;
  heel: number;
  gm: number;
  kg: number;
  lcg: number;
  tcg: number;
  vcg: number;
  lcb: number;
  status: 'stable' | 'warning' | 'danger';
  issues: StabilityIssue[];
}

export interface StabilityIssue {
  metric: 'draft' | 'trim' | 'heel' | 'gm';
  severity: 'warning' | 'danger';
  message: string;
}

export type StowageConflictType =
  | 'overweight'
  | 'wrong-port'
  | 'top-heavy'
  | 'segregation'
  | 'stack-limit'
  | 'stability'
  | 'reefer-power';

export interface StowageConflict {
  id: string;
  type: StowageConflictType;
  severity: 'warning' | 'danger';
  slot: Slot;
  containerIds: string[];
  title: string;
  detail: string;
  suggestion: string;
}

export interface PlannerState {
  vessel: VesselSpec;
  ports: Port[];
  bays: Bay[];
  containers: Container[];
  plans: StowagePlan[];
  activePlanId: string;
  selectedContainerId: string | null;
  selectedSlot: Slot | null;
  highlightedConflictId: string | null;
  past: StowagePlan[][];
  future: StowagePlan[][];
  notice: string | null;
  /** 按操作号记录的写操作日志 */
  operations: OperationRecord[];
  /** 写盘持久化状态 */
  persist: PersistState;
}
