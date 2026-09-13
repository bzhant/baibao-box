/**
 * 白的百宝箱 · 核心接口契约
 *
 * 这是全项目的设计中枢：
 *  - EngineAdapter       引擎适配器（决定"能读什么游戏"）
 *  - TranslationProvider 翻译 Provider（决定"用什么翻"）
 *  - TextEntry           贯穿 抽取 → 翻译 → 回写 的最小单元
 *
 * 红线：签名以本文件为准。要改先改这里，并同步所有实现与测试。
 */

// ─────────────────────────────────────────────────────────────
// 文本条目：最小数据单元
// ─────────────────────────────────────────────────────────────

export type EntryStatus = 'pending' | 'translated' | 'reviewed' | 'conflict';

export interface TextEntry {
  /** 引擎 id（与适配器 id 一致，如 'mvmz' / 'renpy' / 'krkr'） */
  engine: string;
  /** 来源定位：文件路径 + 节点路径（如 'data/Map001.json#/events/3/pages/0/list/12'） */
  path: string;
  /** 字段键（如 'name' / 'message' / 'description'） */
  key: string;
  /** 原文（控制符已完整保留，未做任何改动） */
  source: string;
  /** 译文 */
  translated?: string;
  status: EntryStatus;
  /** 上下文（场景名 / 角色名 / 前后句），用于提升机翻连贯性 */
  context?: string;
  /** 引擎相关的附加数据（控制符映射、原始 JSON 指针等） */
  extra?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// 引擎适配器
// ─────────────────────────────────────────────────────────────

export interface DetectResult {
  /** 是否命中本引擎 */
  matched: boolean;
  engineId: string;
  /** 识别到的版本（如 'MZ 1.6' / 'RenPy 7.4'），未知则省略 */
  version?: string;
  /** 匹配置信度 0..1；宽容模式下"结构匹配但版本未知"给 < 1 的较高值 */
  confidence: number;
  notes?: string[];
}

export interface EngineCaps {
  /** 支持静态文件抽取 */
  staticExtract: boolean;
  /** 支持运行时 hook 抽取 */
  runtimeHook: boolean;
  /** 支持静态回写 */
  repack: boolean;
  /** 有游戏修改器（cheat）能力 */
  cheat: boolean;
  /** 支持地图导出 */
  mapExport: boolean;
  /** 支持存档编辑 */
  saveEdit: boolean;
}

export interface RepackResult {
  /** 真正写进去的条数 */
  written: number;
  /** 目标位置**已经是这个译文**、无需改动的条数（回写是幂等的） */
  unchanged: number;
  /** 因定位失败 / 无译文 / 状态不安全而跳过的条数 */
  skipped: number;
  /** 回写前的自动备份目录；本次没有任何改动时为空串 */
  backupDir: string;
  errors: string[];
  /** 非致命提示（如"原编码装不下译文，已改用 UTF-8 with BOM"） */
  notes?: string[];
}

/** 字体注入结果（引擎可选能力） */
export interface FontInjectOutcome {
  /** 本次是否真的做了改动（false = 已是目标状态） */
  applied: boolean;
  /** 一句话说明，可直接展示给用户 */
  detail: string;
  notes: string[];
  /**
   * **字形覆盖校验**：确认译文里的每个字在本机都有字体能显示。
   * 这是"能看"的保证 —— 配好了字体名却渲染成豆腐块，等于没汉化。
   */
  coverage?: {
    stack: string[];
    /** 本机无任何候选字体能显示的字符 */
    missing: string[];
    ok: boolean;
  };
}

export interface EngineAdapter {
  id: string;
  displayName: string;
  /** 识别游戏目录是否为本引擎、什么版本 */
  detect(gameDir: string): Promise<DetectResult>;
  /** 静态抽取文本（流式，避免大游戏一次性载入内存） */
  extract(gameDir: string): AsyncIterable<TextEntry>;
  /** 把译文回写为游戏可读的形式；必须先备份 */
  repack(gameDir: string, entries: TextEntry[]): Promise<RepackResult>;
  capabilities: EngineCaps;
  /**
   * 声明式元数据（界面靠它自适应，不含逻辑）。
   * 注册表会把它连同 capabilities 一起交给工作台。
   *
   * 可选：已经移出计划、不再维护的引擎（如 KiriKiri）不必补这份数据 ——
   * 界面缺字段就用默认值，而不是逼着一个被冻结的适配器跟着改。
   */
  manifest?: EngineManifest;

  /**
   * 可选能力：注入中文字体支持，解决"译文变方框"。
   * 具体机制各引擎不同（MV 改 locale / MZ 改 fallbackFonts / Ren'Py 改 gui.text_font…），
   * 流水线只调这个方法，不关心实现细节。未实现即视为该引擎不需要或尚未支持。
   *
   * `opts.sampleText`：给一段**真实译文样本**，实现方应据此校验
   * "这台机器上真的有字体能显示这些字"（缺字检查），并把结果写进 notes/coverage。
   */
  injectCjkFont?(
    gameDir: string,
    opts?: { cjkStack?: string; sampleText?: string },
  ): Promise<FontInjectOutcome>;
  /** 可选能力：还原字体注入（走通用补丁机制） */
  restoreCjkFont?(gameDir: string): Promise<{ restored: number; errors: string[] } | null>;
}

/**
 * 引擎清单：**声明式元数据**，供注册表与工作台读取（不实现逻辑）。
 *
 * ★ 为什么要有它（决策记录）：
 *   引擎数量一多，"每个引擎一套专属 HTML 模板"的写法必然失控 ——
 *   所以这里走"**组件化 + 引擎声明式配置**"，而不是手写几十种模板。
 *
 *   这就是那个"声明式配置"的载体：**引擎自己能回答的问题，都以数据形式写在这里**，
 *   界面只读数据、不含任何 `if (engineId === 'mvmz')` 分支。
 *   加一个新引擎 = 加一份 manifest，**界面一行都不用改**。
 *
 *   下面的字段全部是"界面/流水线需要、而只有引擎自己知道"的东西。
 */
export interface EngineManifest {
  id: string;
  displayName: string;
  /** 结构化探测规则（由适配器 interpret），如特征文件/目录/magic */
  detectRules: unknown;
  /** 可翻译字段白名单（区分 显示文本 / 代码 / 资源路径） */
  translatableFields: string[];

  // ── 以下是"给界面看"的声明式字段（本次新增，都是纯数据） ──
  //
  // ⚠️ 这里**刻意不放 capabilities** —— 适配器上已经有一份了。
  //    同一个事实存两处，早晚会不一致（而且不一致时很难发现：
  //    界面读一边、流水线读另一边）。所以由 registry 在 listManifests()
  //    里把适配器的 capabilities 合并进来，保持**单一来源**。

  /**
   * 该选哪一层目录 —— **用户最容易做错的一步**。
   *
   * 各引擎布局不同：MV 发布态要选含 `www/` 的那层、MZ 选含 `data/` 的根、
   * Ren'Py 选含 `game/` 的根。选错的表现是"没识别出引擎"，而用户并不知道自己错在哪。
   * 所以让引擎自己把这句话说清楚。
   */
  rootHint: string;

  /**
   * 这类游戏**常见的源语言**。
   *
   * 为什么由引擎给而不是全局写死：源语言候选与引擎的受众强相关
   * （日系 galgame/RPG 以 ja 为主，欧美独立游戏以 en 为主）。
   * 界面据此排布下拉的默认值与顺序，而不是永远把 ja 放第一。
   */
  sourceLanguages: Array<{ id: string; label: string }>;

  /** 注入中文字体时**会发生什么**（各引擎机制不同，要让用户知道改了什么） */
  fontOptionNote?: string;

  /**
   * 已知坑 / 注意事项，显示在识别结果旁边。
   * 例如"数据可能被加密，加密时静态路线不可用"。
   */
  caveats: string[];
}

// ─────────────────────────────────────────────────────────────
// 翻译 Provider
// ─────────────────────────────────────────────────────────────

export interface TranslateRequest {
  id: string;
  /** 待译文本（可已被 text-kernel 掩码控制符） */
  source: string;
  from: string; // 源语言，如 'ja'
  to: string;   // 目标语言，如 'zh-CN'
  context?: string;
  /** 术语表：source term -> 强制译文 */
  glossary?: Record<string, string>;
}

export interface TranslateResult {
  id: string;
  translated: string;
  provider: string;
  /** 是否命中本地翻译记忆（未真正调用远端） */
  fromCache?: boolean;
}

export interface ProviderQuota {
  limit?: number;
  used?: number;
  resetAt?: number; // epoch ms
}

export interface TranslationProvider {
  id: string;
  displayName: string;
  /** 批量翻译；实现方负责限流与并发 */
  translate(reqs: TranslateRequest[]): Promise<TranslateResult[]>;
  /** 配额/余额（可选；本地模型可返回 {}） */
  quota?(): Promise<ProviderQuota>;
  /** 是否离线可用（本地模型 true） */
  offline?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 游戏库 / 项目
// ─────────────────────────────────────────────────────────────

export interface GameRecord {
  id: string;
  title: string;
  dir: string;
  engineId?: string;
  engineVersion?: string;
  coverPath?: string;
  addedAt: number;
  lastPlayedAt?: number;
}
