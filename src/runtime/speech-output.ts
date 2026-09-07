import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AtomicJsonStore } from '../core/state-file.js';
import { runManagedCommand } from '../core/managed-process.js';
import { PRE_MIMI_DATA_DIRECTORY } from '../core/mimi-legacy.js';
import type { TtsConfig } from '../config.js';

export type SpeechEngine = 'auto' | 'chattts' | 'kokoro';
export type SpeechLanguage = 'auto' | 'zh' | 'en' | 'ja';

export interface SpeechVoice {
  id: string;
  engine: Exclude<SpeechEngine, 'auto'>;
  language: Exclude<SpeechLanguage, 'auto'>;
  label: string;
  gender?: 'female' | 'male';
}

export interface SpeechSynthesisOptions {
  engine?: SpeechEngine;
  voice?: string;
  language?: SpeechLanguage;
  speed?: number;
}

export interface SpeechAudio {
  id: string;
  file: string;
  format: 'wav' | 'm4a' | 'mp3' | 'aiff' | 'flac' | 'ogg';
  engine: Exclude<SpeechEngine, 'auto'> | 'unknown';
  voice?: string;
  language: SpeechLanguage;
  createdAt: string;
}

const audioSchema = z.object({
  id: z.string().uuid(), file: z.string(), format: z.literal('wav'),
  engine: z.enum(['chattts', 'kokoro']), voice: z.string().optional(),
  language: z.enum(['auto', 'zh', 'en', 'ja']), createdAt: z.string(),
}).strict();
const renderSchema = z.object({
  status: z.enum(['started', 'ready', 'uncertain']), audio: audioSchema,
  error: z.string().max(2_000).optional(),
}).strict();
const rendersSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), renderSchema) }).strict();
type RenderRecord = z.infer<typeof renderSchema>;

export class SpeechRenderUncertainError extends Error {
  constructor(readonly audio: SpeechAudio, message: string) { super(message); }
}

type ValidatedSpeechOptions = Required<Pick<
  SpeechSynthesisOptions,
  'engine' | 'language' | 'speed'
>> & Pick<SpeechSynthesisOptions, 'voice'>;

type ResolvedSpeechOptions = Omit<ValidatedSpeechOptions, 'engine' | 'language'> & {
  engine: Exclude<SpeechEngine, 'auto'>;
  language: Exclude<SpeechLanguage, 'auto'>;
};

export interface SpeechOutputStatus {
  enabled: boolean;
  renderer: string;
  playback: string;
  voices: number;
  queuedPlayback: number;
  lastError?: string;
}

export const SPEECH_VOICES: readonly SpeechVoice[] = Object.freeze(([
  { id: 'chattts:male-1', engine: 'chattts', language: 'zh', label: 'ChatTTS Male 1', gender: 'male' },
  { id: 'chattts:male-3', engine: 'chattts', language: 'zh', label: 'ChatTTS Male 3', gender: 'male' },
  { id: 'chattts:female-3', engine: 'chattts', language: 'zh', label: 'ChatTTS Female 3', gender: 'female' },
  { id: 'chattts:young-lively', engine: 'chattts', language: 'zh', label: 'ChatTTS Young Lively Female', gender: 'female' },
  { id: 'chattts:mature-steady', engine: 'chattts', language: 'zh', label: 'ChatTTS Mature Steady Female', gender: 'female' },
  { id: 'zf_xiaoxiao', engine: 'kokoro', language: 'zh', label: 'Kokoro Xiaoxiao', gender: 'female' },
  { id: 'zf_xiaoyi', engine: 'kokoro', language: 'zh', label: 'Kokoro Xiaoyi', gender: 'female' },
  { id: 'zm_yunjian', engine: 'kokoro', language: 'zh', label: 'Kokoro Yunjian', gender: 'male' },
  { id: 'zm_yunyang', engine: 'kokoro', language: 'zh', label: 'Kokoro Yunyang', gender: 'male' },
  { id: 'am_echo', engine: 'kokoro', language: 'en', label: 'Kokoro Echo', gender: 'male' },
] satisfies SpeechVoice[]).map((voice) => Object.freeze(voice)));

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type SpeechCommandRunner = (
  command: string,
  args: readonly string[],
  options: { environment?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
) => Promise<CommandResult>;

function validateOptions(options: SpeechSynthesisOptions): ValidatedSpeechOptions {
  let engine = options.engine ?? 'auto';
  let language = options.language ?? 'auto';
  const speed = options.speed ?? 1;
  if (!['auto', 'chattts', 'kokoro'].includes(engine)) throw new Error(`未知 TTS 引擎：${engine}`);
  if (!['auto', 'zh', 'en', 'ja'].includes(language)) throw new Error(`未知 TTS 语言：${language}`);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new Error('TTS 语速必须在 0.5 到 2 之间');
  }
  const voice = options.voice?.trim();
  if (voice) {
    const catalogVoice = SPEECH_VOICES.find((candidate) => candidate.id === voice);
    if (!catalogVoice) throw new Error(`未知 TTS 音色：${voice}`);
    const voiceEngine = catalogVoice.engine;
    if (engine !== 'auto' && engine !== voiceEngine) {
      throw new Error(`音色 ${voice} 不属于 ${engine} 引擎`);
    }
    if (engine === 'auto') engine = voiceEngine;
    if (language === 'auto' && catalogVoice) language = catalogVoice.language;
  }
  return { engine, language, speed, ...(voice ? { voice } : {}) };
}

function detectedLanguage(text: string): Exclude<SpeechLanguage, 'auto'> {
  if (/[\u3040-\u30ff\u31f0-\u31ff]/u.test(text)) return 'ja';
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text)) return 'zh';
  return 'en';
}

function resolveOptions(text: string, options: ValidatedSpeechOptions): ResolvedSpeechOptions {
  const language = options.language === 'auto' ? detectedLanguage(text) : options.language;
  const engine = options.engine === 'auto'
    ? language === 'zh' ? 'chattts' : 'kokoro'
    : options.engine;
  return { ...options, engine, language };
}

function actualEngine(stdout: string, requested: SpeechEngine): Exclude<SpeechEngine, 'auto'> {
  const matches = [...stdout.matchAll(/\bengine=(chattts|kokoro)\b/g)];
  const detected = matches.at(-1)?.[1];
  if (detected === 'chattts' || detected === 'kokoro') return detected;
  return requested === 'kokoro' ? 'kokoro' : 'chattts';
}

function actualVoice(stdout: string, requested?: string): string | undefined {
  const matches = [...stdout.matchAll(/\bvoice=([^\s]+)\b/g)];
  return matches.at(-1)?.[1] ?? requested;
}

export class SpeechOutput {
  private enabled: boolean;
  private playbackTail = Promise.resolve();
  private queuedPlayback = 0;
  private lastError?: string;
  private readonly renders: AtomicJsonStore<z.infer<typeof rendersSchema>>;

  constructor(
    private readonly config: TtsConfig,
    private readonly outputDirectory: string,
    private readonly commandRunner: SpeechCommandRunner = runManagedCommand,
  ) {
    this.enabled = config.enabled;
    this.renders = new AtomicJsonStore(path.join(outputDirectory, 'renders.json'), {
      defaultValue: () => ({ version: 1, entries: {} }), decode: (value) => rendersSchema.parse(value),
      preserveSchemaMismatch: true, recoverCorrupt: false,
    });
  }

  listVoices(): SpeechVoice[] {
    return SPEECH_VOICES.map((voice) => ({ ...voice }));
  }

  status(): SpeechOutputStatus {
    return {
      enabled: this.enabled,
      renderer: this.config.command,
      playback: this.config.playbackCommand,
      voices: SPEECH_VOICES.length,
      queuedPlayback: this.queuedPlayback,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<SpeechOutputStatus> {
    if (enabled) await this.assertCommandsAvailable();
    this.enabled = enabled;
    if (enabled) this.lastError = undefined;
    return this.status();
  }

  async synthesize(
    text: string,
    options: SpeechSynthesisOptions = {},
    signal?: AbortSignal,
  ): Promise<SpeechAudio> {
    this.assertEnabled();
    if (!text.trim()) throw new Error('TTS 文本不能为空');
    if (text.length > 20_000) throw new Error('单次 TTS 文本不能超过 20000 个字符');
    signal?.throwIfAborted();
    await this.assertCommandsAvailable(false);
    const selected = resolveOptions(text, validateOptions(options));
    await mkdir(this.outputDirectory, { recursive: true, mode: 0o700 });
    const fingerprint = createHash('sha256').update(JSON.stringify({ text, selected, renderer: this.config.command })).digest('hex');
    const id = randomUUID();
    const input = path.join(this.outputDirectory, `.${id}.txt`);
    const output = path.join(this.outputDirectory, `${id}.wav`);
    const proposed: RenderRecord = { status: 'started', audio: {
      id, file: output, format: 'wav', engine: selected.engine, language: selected.language,
      ...(selected.voice ? { voice: selected.voice } : {}), createdAt: new Date().toISOString(),
    } };
    const claimed = await this.renders.updateWhen((state) => {
      const existing = state.entries[fingerprint];
      if (existing) return { result: existing, changed: false };
      state.entries[fingerprint] = proposed;
      return { result: proposed, changed: true };
    });
    if (claimed.audio.id !== id) {
      if (claimed.status === 'ready') {
        await this.existingAudioFile(claimed.audio.file, true);
        return { ...claimed.audio };
      }
      throw new SpeechRenderUncertainError(claimed.audio,
        '同一内容和音色已有未确认的生成操作；先 inspect 该 audioId，不要重复合成或更换引擎启动副本。');
    }
    try {
      await writeFile(input, text, { encoding: 'utf8', mode: 0o600 });
      const result = await this.commandRunner(
        this.config.command,
        [input, '--no-play', output],
        {
          timeoutMs: this.config.synthesisTimeoutMs,
          signal,
          environment: {
            ...process.env,
            MIMI_TTS_ENGINE: selected.engine,
            MIMI_TTS_LANGUAGE: selected.language,
            MIMI_TTS_SPEED: String(selected.speed),
            ...(selected.voice ? { MIMI_TTS_VOICE: selected.voice } : {}),
          },
        },
      );
      const info = await stat(output);
      if (!info.isFile() || info.size === 0) throw new Error('TTS 渲染器未生成有效 WAV 文件');
      await chmod(output, 0o600);
      const renderedVoice = actualVoice(result.stdout, selected.voice);
      const audio: SpeechAudio = {
        id,
        file: output,
        format: 'wav',
        engine: actualEngine(result.stdout, selected.engine),
        ...(renderedVoice ? { voice: renderedVoice } : {}),
        language: selected.language,
        createdAt: new Date().toISOString(),
      };
      await this.renders.update((state) => {
        state.entries[fingerprint] = { status: 'ready', audio: audioSchema.parse(audio) };
      });
      this.lastError = undefined;
      return { ...audio };
    } catch (error) {
      this.rememberError(error);
      await this.renders.update((state) => {
        state.entries[fingerprint] = { ...proposed, status: 'uncertain', error: this.lastError?.slice(0, 2_000) };
      });
      throw new SpeechRenderUncertainError(proposed.audio,
        `${this.lastError}；生成结果尚未确认，文件可能稍后到达。先 inspect ${id}，不要自动重新生成。`);
    } finally {
      await unlink(input).catch(() => undefined);
    }
  }

  play(audio: SpeechAudio | string, signal?: AbortSignal): Promise<SpeechAudio> {
    this.assertEnabled();
    const previous = this.playbackTail;
    this.queuedPlayback += 1;
    const playback = previous.then(async () => {
      this.assertEnabled();
      signal?.throwIfAborted();
      const selected = await this.resolveAudio(audio);
      await access(selected.file, fsConstants.R_OK);
      await this.commandRunner(this.config.playbackCommand, [selected.file], {
        timeoutMs: this.config.playbackTimeoutMs,
        signal,
      });
      this.lastError = undefined;
      return { ...selected };
    }).catch((error) => {
      this.rememberError(error);
      throw error;
    }).finally(() => {
      this.queuedPlayback = Math.max(0, this.queuedPlayback - 1);
    });
    this.playbackTail = playback.then(() => undefined, () => undefined);
    return playback;
  }

  async inspect(id?: string) {
    const entries = Object.values((await this.renders.read()).entries);
    const selected = id ? entries.filter((entry) => entry.audio.id === id) : entries.slice(-20);
    return Promise.all(selected.map(async (entry) => ({ ...entry,
      fileExists: await stat(entry.audio.file).then((info) => info.isFile() && info.size > 0).catch(() => false),
      retryable: false,
      next: entry.status === 'ready' ? 'play existing audioId or file; do not synthesize again'
        : 'This is the local receipt, not a live backend job query. Report the original audioId and unconfirmed status; do not loop over unchanged receipts or regenerate. File existence alone does not confirm completion.',
    })));
  }

  private async resolveAudio(audio: SpeechAudio | string): Promise<SpeechAudio> {
    if (typeof audio !== 'string') return this.resolveAudio(audio.id);
    const entries = Object.values((await this.renders.read()).entries);
    const recorded = entries.find((entry) => entry.audio.id === audio || entry.audio.file === audio);
    if (recorded) {
      if (recorded.status !== 'ready') throw new SpeechRenderUncertainError(recorded.audio, '音频生成尚未确认，先 inspect 同一操作。');
      await this.existingAudioFile(recorded.audio.file, true);
      return recorded.audio;
    }
    if (!path.isAbsolute(audio)) throw new Error(`TTS 音频不存在：${audio}`);
    const file = await this.existingAudioFile(audio, false);
    const info = await stat(file);
    return { id: randomUUID(), file, format: path.extname(file).slice(1) as SpeechAudio['format'],
      engine: 'unknown', language: 'auto', createdAt: info.mtime.toISOString() };
  }

  private async existingAudioFile(file: string, registered: boolean): Promise<string> {
    const resolved = await realpath(file);
    const info = await stat(resolved);
    if (!info.isFile() || info.size === 0) throw new Error('音频文件不存在或为空');
    if (!registered && (resolved.split(path.sep).some((part) => part === '.mimi-agent' || part === PRE_MIMI_DATA_DIRECTORY)
      || !/\.(wav|m4a|mp3|aiff|flac|ogg)$/iu.test(resolved))) {
      throw new Error('只能播放已登记音频或私有运行目录之外的现有音频文件');
    }
    if (registered && path.dirname(resolved) !== await realpath(this.outputDirectory)) {
      throw new Error('已登记音频不能通过符号链接越出产物目录');
    }
    await access(resolved, fsConstants.R_OK);
    return resolved;
  }

  async speak(
    text: string,
    options: SpeechSynthesisOptions = {},
    signal?: AbortSignal,
  ): Promise<SpeechAudio> {
    const audio = await this.synthesize(text, options, signal);
    return this.play(audio, signal);
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error('TTS 已关闭；调用 speech.setEnabled(true) 或设置 MIMI_TTS_ENABLED=true 后再试');
    }
  }

  private async assertCommandsAvailable(includePlayback = true): Promise<void> {
    await access(this.config.command, fsConstants.X_OK).catch(() => {
      throw new Error(`TTS 渲染器不可执行：${this.config.command}`);
    });
    if (!includePlayback) return;
    await access(this.config.playbackCommand, fsConstants.X_OK).catch(() => {
      throw new Error(`TTS 播放器不可执行：${this.config.playbackCommand}`);
    });
  }

  private rememberError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }
}

const sharedOutputs = new Map<string, SpeechOutput>();

export function sharedSpeechOutput(config: TtsConfig, dataRoot: string): SpeechOutput {
  const outputDirectory = path.join(dataRoot, 'media', 'tts');
  const key = JSON.stringify({ ...config, outputDirectory });
  const existing = sharedOutputs.get(key);
  if (existing) return existing;
  const created = new SpeechOutput(config, outputDirectory);
  sharedOutputs.set(key, created);
  return created;
}
