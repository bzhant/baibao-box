import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { parseSerializedFile, serializedFromBundleBuffer, describeSerialized } from './serialized';
import { isUnityFs } from './unityfs';

/**
 * Unity 游戏侦察（适配前置）：报告"可译文本可能在哪里"。
 *
 * 为什么用 test 文件承载：项目里 `scripts/verify-*.ts` 约定用
 * `node --experimental-strip-types` 直跑，但 Unity 模块用的是**省略扩展名**的相对导入
 * （`from './unityfs'`），node 的 ESM 解析器不认 —— 所以这套走 vitest（能解析）。
 *
 * 环境变量 BB_UNITY_DIR 指定游戏目录；未设置则跳过（CI 友好）。
 */
const DIR = process.env.BB_UNITY_DIR ?? '';

const CLASS_NAMES: Record<number, string> = {
  49: 'TextAsset', 114: 'MonoBehaviour', 115: 'MonoScript',
  128: 'Font', 28: 'Texture2D', 48: 'Shader', 142: 'AssetBundle',
};

function looksTranslatable(name: string, classID: number): boolean {
  if (classID === 49 || classID === 114) return true;
  return /Localization|StringTable|Text|Dialogue|Message|Script|Story|Scenario|Language/i.test(name);
}

function findDataDir(input: string): string | null {
  if (basename(input).endsWith('_Data')) return input;
  try {
    const d = readdirSync(input).find((f) => f.endsWith('_Data'));
    return d ? join(input, d) : null;
  } catch {
    return null;
  }
}

function findContainers(dataDir: string, limit: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length > 400) return;
    let items: string[] = [];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(dir, it);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (['.assets', '.bundle', '.unity3d', '.resource'].includes(extname(it).toLowerCase())) {
        out.push(p);
      } else if (extname(it) === '' && depth <= 1) {
        out.push(p);
      }
    }
  };
  walk(dataDir, 0);
  return out.slice(0, limit);
}

describe.skipIf(!DIR || !existsSync(DIR))('Unity 侦察', () => {
  it('报告可译文本的分布', () => {
    const dataDir = findDataDir(DIR);
    expect(dataDir, `在 ${DIR} 下找不到 *_Data`).toBeTruthy();
    const dd = dataDir as string;
    const root = join(dd, '..');

    const isIl2 = existsSync(join(dd, 'il2cpp_data')) || existsSync(join(root, 'GameAssembly.dll'));
    const isMono = existsSync(join(dd, 'Managed', 'Assembly-CSharp.dll'));
    const build = isIl2 ? 'IL2CPP' : isMono ? 'Mono' : '未知';

    console.log(`\n=== Unity 侦察：${basename(root)} ===`);
    console.log(`Data     : ${dd}`);
    console.log(`构建类型 : ${build}`);

    const cs = findContainers(dd, 400);
    console.log(`\n容器 ${cs.length} 个，逐个解析：`);

    const global = new Map<string, number>();
    const translatable = new Map<string, number>();
    let ok = 0;
    let fail = 0;

    for (const c of cs) {
      const rel = c.slice(root.length + 1);
      try {
        const buf = readFileSync(c);
        const sf = isUnityFs(buf) ? serializedFromBundleBuffer(buf) : parseSerializedFile(buf);
        ok++;
        console.log(`  [OK] ${rel}`);
        console.log(`       ${describeSerialized(sf)}`);
        const per = new Map<string, number>();
        for (const o of sf.objects) {
          const t = sf.types[o.typeID];
          const cid = t ? t.classID : -1;
          const tn = t?.nodes?.[0]?.type || CLASS_NAMES[cid] || `classID=${cid}`;
          per.set(tn, (per.get(tn) || 0) + 1);
          global.set(tn, (global.get(tn) || 0) + 1);
          if (looksTranslatable(tn, cid)) translatable.set(tn, (translatable.get(tn) || 0) + 1);
        }
        const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        console.log('       Top：' + top.map(([k, v]) => `${k}x${v}`).join('  '));
      } catch (e) {
        fail++;
        console.log(`  [失败] ${rel} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`\n解析成功 ${ok}，失败 ${fail}`);
    console.log('\n=== 全局对象类型 Top 20 ===');
    for (const [k, v] of [...global.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
    console.log('\n=== 很可能含可译文本的类型 ===');
    if (!translatable.size) {
      console.log('  （无 —— 文本可能在别处，或类型树被剥离）');
    } else {
      for (const [k, v] of [...translatable.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(v).padStart(6)}  ${k}`);
      }
    }
    expect(true).toBe(true);
  }, 180000);
});
