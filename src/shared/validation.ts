export function positiveInteger(value: unknown, name: string, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name}必须是 1 到 ${max} 之间的整数`);
  }
  return value;
}

export function language(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) {
    throw new Error(`${name}不是有效的语言代码`);
  }
  return value;
}

export function isEntryStatus(value: unknown): value is 'pending' | 'translated' | 'reviewed' | 'conflict' {
  return ['pending', 'translated', 'reviewed', 'conflict'].includes(value as string);
}
