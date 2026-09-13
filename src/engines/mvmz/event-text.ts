/**
 * MV/MZ 事件对白抽取（适配器里最难的一块）。
 *
 * MV/MZ 的"剧情文本"不在数据库字段里，而是散落在各 JSON 的**事件指令流**
 * （`list[]`）中。每条指令形如：
 *   { "code": 401, "indent": 0, "parameters": ["こんにちは、\\N[1]！"] }
 * 可翻译的文本藏在少数几种指令的 parameters 里：
 *   401  显示文本（行）      parameters[0] = 文本
 *   405  滚动文本（行）      parameters[0] = 文本
 *   102  显示选项            parameters[0] = 选项字符串数组
 * （其余 200+ 种指令——移动/音效/变量/脚本——都不是显示文本，不抽）
 *
 * 文本出现的三种宿主结构：
 *   CommonEvents.json   公共事件：  [事件].list[]
 *   Troops.json         敌群：      [敌群].pages[].list[]
 *   MapXXX.json         地图：      .events[]（[0]恒为 null）.pages[].list[]
 *
 * 关键设计：每个可翻译槽位用 **JSON-pointer 段数组** 定位，
 * 使 repack 能按同一套指针**通用回写**，无需为每种指令特判。
 */

export interface TextSlot {
  /** JSON-pointer 段（不含文件部分），如 ['7','list','15','parameters','0'] */
  pointer: string[];
  /** 语义键：'choice' / 'cmd401' / 'cmd405' … */
  key: string;
  source: string;
}

interface CmdLike {
  code?: unknown;
  parameters?: unknown;
}

/** 文本型指令：code -> 需要翻译的 parameters 下标 */
const TEXT_PARAM: Record<number, number[]> = {
  401: [0], // 显示文本
  405: [0], // 滚动文本
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** 遍历一条指令流（list[]），产出可翻译槽位 */
function* fromList(list: unknown, prefix: string[]): Generator<TextSlot> {
  if (!Array.isArray(list)) return;
  for (let ci = 0; ci < list.length; ci++) {
    const cmd = list[ci] as CmdLike | null;
    if (!cmd || typeof cmd.code !== 'number') continue;
    const params = Array.isArray(cmd.parameters) ? cmd.parameters : [];

    // 选项（102）：parameters[0] 是字符串数组
    if (cmd.code === 102) {
      const choices = params[0];
      if (Array.isArray(choices)) {
        for (let i = 0; i < choices.length; i++) {
          if (isNonEmptyString(choices[i])) {
            yield {
              pointer: [...prefix, String(ci), 'parameters', '0', String(i)],
              key: 'choice',
              source: choices[i],
            };
          }
        }
      }
      continue;
    }

    // 文本型指令（401 / 405）
    const idxs = TEXT_PARAM[cmd.code];
    if (idxs) {
      for (const pi of idxs) {
        const v = params[pi];
        if (isNonEmptyString(v)) {
          yield {
            pointer: [...prefix, String(ci), 'parameters', String(pi)],
            key: `cmd${cmd.code}`,
            source: v,
          };
        }
      }
    }
  }
}

/** 遍历 pages[].list（敌群 / 地图事件共用） */
function* fromPages(pages: unknown, prefix: string[]): Generator<TextSlot> {
  if (!Array.isArray(pages)) return;
  for (let pi = 0; pi < pages.length; pi++) {
    const list = (pages[pi] as { list?: unknown } | null)?.list;
    yield* fromList(list, [...prefix, 'pages', String(pi), 'list']);
  }
}

/**
 * 按文件类型抽取事件文本。
 * fileName 形如 'CommonEvents.json' / 'Troops.json' / 'Map003.json'。
 */
export function* extractEventText(fileName: string, json: unknown): Generator<TextSlot> {
  // 公共事件：根是事件数组，每个事件有 list
  if (fileName === 'CommonEvents.json') {
    if (!Array.isArray(json)) return;
    for (let i = 0; i < json.length; i++) {
      const list = (json[i] as { list?: unknown } | null)?.list;
      yield* fromList(list, [String(i), 'list']);
    }
    return;
  }

  // 敌群：根是数组，每个敌群有 pages
  if (fileName === 'Troops.json') {
    if (!Array.isArray(json)) return;
    for (let i = 0; i < json.length; i++) {
      yield* fromPages((json[i] as { pages?: unknown } | null)?.pages, [String(i)]);
    }
    return;
  }

  // 地图：.events[]（[0] 恒为 null），每个事件有 pages
  if (/^Map\d+\.json$/i.test(fileName)) {
    const events = (json as { events?: unknown } | null)?.events;
    if (!Array.isArray(events)) return;
    for (let ei = 0; ei < events.length; ei++) {
      const ev = events[ei] as { pages?: unknown } | null;
      if (!ev) continue;
      yield* fromPages(ev.pages, ['events', String(ei)]);
    }
    return;
  }
  // 其它文件不含事件文本，由 DB_FIELDS 或忽略处理
}

/** 参与事件文本抽取的文件（除 Map\d+ 外的固定文件） */
export const EVENT_FILES = ['CommonEvents.json', 'Troops.json'];

/** 判断某个 data 文件名是否需要做事件抽取 */
export function isEventFile(fileName: string): boolean {
  return EVENT_FILES.includes(fileName) || /^Map\d+\.json$/i.test(fileName);
}
