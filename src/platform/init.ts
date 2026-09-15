import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TextStore } from './store/text-store';

/**
 * platform 层初始化：打开文本库、暴露单例。
 * 只有主进程调用；渲染层通过 IPC 访问（IPC 白名单）。
 */

let store: TextStore | null = null;
let leases = 0;

/** 文本库路径：放在 userData 下（安装目录只读，不能写数据）。 */
export function dbPath(): string {
  return join(app.getPath('userData'), 'baibao.db');
}

export function initPlatform(): TextStore {
  if (store) return store;
  mkdirSync(app.getPath('userData'), { recursive: true });
  store = new TextStore(dbPath());
  return store;
}

/** Service calls share a connection until the last overlapping operation finishes. */
export function acquirePlatform(): TextStore {
  const s = initPlatform();
  leases++;
  return s;
}

export function releasePlatform(): void {
  if (leases > 0) leases--;
  if (leases === 0) closePlatform();
}

export function getStore(): TextStore {
  if (!store) throw new Error('[platform] 未初始化：请先调用 initPlatform()');
  return store;
}

export function closePlatform(): void {
  store?.close();
  store = null;
  leases = 0;
}
