import { z } from 'zod';

export const computerAccessSchema = z.enum(['none', 'observe', 'background', 'foreground', 'admin']);
export type ComputerAccess = z.infer<typeof computerAccessSchema>;

export interface ComputerConfig {
  backend: 'cua';
  driverCommand: string;
  actionTimeoutMs: number;
  maxActionsPerRun: number;
  maxScreenshotsPerRun: number;
  pauseWhenTargetFrontmost: boolean;
  defaultAccess: ComputerAccess;
  foregroundLeaseSeconds: number;
  artifactMaxBytes: number;
}

const targetSelectorSchema = z.object({
  bundleId: z.string().min(1).max(500).optional(),
  pid: z.number().int().positive().optional(),
  windowId: z.number().int().positive().optional(),
}).refine((value) => value.bundleId !== undefined || value.pid !== undefined, {
  message: 'target 至少需要 bundleId 或 pid',
});

const rectSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const computerObserveInputSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('targets'),
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    scope: z.literal('window'),
    target: targetSelectorSchema,
    query: z.string().max(500).optional(),
    includeScreenshot: z.boolean().default(false),
    maxElements: z.number().int().min(1).max(1_000).default(400),
    maxDepth: z.number().int().min(1).max(20).default(12),
  }),
  z.object({
    scope: z.literal('region'),
    observationId: z.string().uuid(),
    rect: rectSchema,
  }),
  z.object({
    scope: z.literal('desktop'),
    includeScreenshot: z.boolean().default(true),
  }),
  z.object({
    scope: z.literal('driver'),
    include: z.array(z.enum(['health', 'permissions', 'config', 'recording'])).min(1).max(4),
    promptForPermissions: z.literal(false).default(false),
  }),
  z.object({ scope: z.literal('session') }),
]);
export type ComputerObserveInput = z.infer<typeof computerObserveInputSchema>;

const dispatchSchema = z.enum(['background', 'foreground']).default('background');
const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const uiActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'), elementIndex: z.number().int().nonnegative().optional(),
    x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    axAction: z.enum(['press', 'show_menu', 'pick', 'confirm', 'cancel', 'open']).optional(),
    dispatch: dispatchSchema,
  }).refine((value) => value.elementIndex !== undefined || (value.x !== undefined && value.y !== undefined), {
    message: 'click 需要 elementIndex 或 x/y',
  }),
  z.object({
    type: z.literal('double_click'), elementIndex: z.number().int().nonnegative().optional(),
    x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(),
    dispatch: dispatchSchema,
  }).refine((value) => value.elementIndex !== undefined || (value.x !== undefined && value.y !== undefined), {
    message: 'double_click 需要 elementIndex 或 x/y',
  }),
  z.object({
    type: z.literal('type_text'), elementIndex: z.number().int().nonnegative().optional(),
    text: z.string().max(10_000), dispatch: dispatchSchema,
  }),
  z.object({
    type: z.literal('set_value'), elementIndex: z.number().int().nonnegative(),
    value: z.union([z.string().max(10_000), z.number().finite(), z.boolean()]),
  }),
  z.object({ type: z.literal('keypress'), keys: z.array(z.string().min(1).max(30)).min(1).max(5), dispatch: dispatchSchema }),
  z.object({
    type: z.literal('scroll'), x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(),
    deltaX: z.number().finite(), deltaY: z.number().finite(), dispatch: dispatchSchema,
  }),
  z.object({ type: z.literal('drag'), path: z.array(pointSchema).min(2).max(20), dispatch: dispatchSchema }),
]);

const controlActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('escalate_session'), reason: z.string().min(1).max(500), detail: z.string().max(2_000).optional() }),
  z.object({ type: z.literal('bring_to_front'), pid: z.number().int().positive(), windowId: z.number().int().positive().optional(), leaseSeconds: z.number().int().min(1).max(300).optional() }),
  z.object({ type: z.literal('handoff_to_user'), pid: z.number().int().positive(), windowId: z.number().int().positive() }),
  z.object({ type: z.literal('release_foreground') }),
  z.object({ type: z.literal('move_cursor'), scope: z.enum(['agent', 'desktop']), x: z.number().finite(), y: z.number().finite() }),
  z.object({ type: z.literal('kill_app'), pid: z.number().int().positive(), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('start_recording'), recordVideo: z.boolean().default(false) }),
  z.object({ type: z.literal('stop_recording') }),
  z.object({ type: z.literal('replay_trajectory'), trajectoryId: z.string().min(1).max(200), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), delayMs: z.number().int().min(0).max(60_000).optional(), stopOnError: z.boolean().default(true) }),
  z.object({ type: z.literal('set_driver_config'), values: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('set_agent_cursor'), enabled: z.boolean().optional(), style: z.object({ color: z.string().max(50).optional(), label: z.string().max(100).optional(), icon: z.enum(['arrow', 'teardrop']).optional(), size: z.number().positive().max(200).optional(), opacity: z.number().min(0).max(1).optional() }).optional() }),
  z.object({ type: z.literal('request_permissions'), permissions: z.array(z.enum(['accessibility', 'screen_recording'])).min(1).max(2) }),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(0).max(30_000) }),
]);

const launchActionSchema = z.object({
  type: z.literal('launch_app'), bundleId: z.string().min(1).max(500).optional(), name: z.string().min(1).max(500).optional(),
  urls: z.array(z.string().max(4_000)).max(20).optional(), newInstance: z.boolean().default(false),
}).refine((value) => value.bundleId !== undefined || value.name !== undefined, { message: 'launch_app 需要 bundleId 或 name' });

export const computerActionSchema = z.union([launchActionSchema, uiActionSchema, controlActionSchema]);

export const computerActInputSchema = z.union([
  z.object({ action: launchActionSchema }),
  z.object({ observationId: z.string().uuid(), action: uiActionSchema }),
  z.object({ action: controlActionSchema }),
]);
export type ComputerActInput = z.infer<typeof computerActInputSchema>;
export type ComputerAction = ComputerActInput['action'];

export interface ComputerTargetSummary {
  bundleId: string;
  pid: number;
  windowId: number;
  appName: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  frontmost?: boolean;
}

export interface ComputerElement {
  index: number;
  role: string;
  label?: string;
  actions?: string[];
  frame?: { x: number; y: number; width: number; height: number };
  secure?: boolean;
  writable?: boolean;
}

export interface BackendSession { id: string }
export interface BackendObservation {
  target?: ComputerTargetSummary;
  frontmost?: boolean;
  dimensions?: { width: number; height: number };
  elements?: ComputerElement[];
  truncated?: boolean;
  screenshot?: { data: string; mediaType: string };
  data?: unknown;
  fromZoom?: boolean;
}

export interface BackendObserveRequest {
  input: ComputerObserveInput;
  target?: ComputerTargetSummary;
}

export interface BackendActionResult {
  status: 'applied' | 'background_unsupported' | 'uncertain';
  delivery?: 'background' | 'foreground';
  data?: unknown;
}

export interface BackendActionRequest {
  input: ComputerActInput;
  target?: ComputerTargetSummary;
  element?: ComputerElement;
  fromZoom?: boolean;
  artifactPath?: string;
}

export interface ComputerBackend {
  readonly kind: 'cua';
  health(signal?: AbortSignal): Promise<Record<string, unknown>>;
  startSession(input: { sessionId: string; captureScope: 'auto' }, signal?: AbortSignal): Promise<BackendSession>;
  listTargets(query: { query?: string; limit: number }, signal?: AbortSignal): Promise<ComputerTargetSummary[]>;
  observe(session: BackendSession, request: BackendObserveRequest, signal?: AbortSignal): Promise<BackendObservation>;
  act(session: BackendSession, request: BackendActionRequest, signal?: AbortSignal): Promise<BackendActionResult>;
  endSession(session: BackendSession, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export class ComputerActionUncertainError extends Error {
  constructor(message = 'Computer 动作结果不确定；为避免重复副作用不会自动重试') {
    super(message);
    this.name = 'ComputerActionUncertainError';
  }
}
