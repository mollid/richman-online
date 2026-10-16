/**
 * 把 docs/gameplay/help_entries.txt 解析成 client/src/ui/helpData.ts 静态数组。
 * 用法：node scripts/gen-help-data.mjs
 * 之所以生成静态文件而不是运行时 fetch：docs/ 不在 public 下，Vite 打包后运行时请求会 404。
 *
 * 繁体转简体：源文件是原版繁体说明，**保持原样不动**（它是对得上原盘的凭据），
 * 转换只发生在这里 —— 上屏的东西一律简体。字表用 tools/t2s-map.json（由 opencc 的
 * t2s 单字映射导出，只收「转换后仍是单字」的条目，避开 一↔壹 这类要按词才判得对的歧义）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../docs/gameplay/help_entries.txt');
const out = resolve(here, '../src/ui/helpData.ts');
const t2s = JSON.parse(readFileSync(resolve(here, '../../tools/t2s-map.json'), 'utf8'));

/** 逐字替换；表里没有的原样留着（简繁同形，或确实缺） */
const toSimplified = (text) => text.replace(/[㐀-鿿]/g, (ch) => t2s[ch] ?? ch);

const raw = readFileSync(src, 'utf8');

/** 源文件尾部混入了控制字符与乱码残留，遇到即截断 */
function clean(text) {
  const cut = text.search(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufff0-\uffff]/);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

const entries = [];
for (const line of raw.split(/\r?\n/)) {
  const m = /^\[(\d+)\]\s*(.*)$/.exec(line);
  if (!m) continue;
  const no = Number(m[1]);
  // `@` 是同一条目内的分段分隔符
  const paragraphs = m[2]
    .split('@')
    .map(clean)
    .map(toSimplified)
    .filter(Boolean);
  if (paragraphs.length === 0) continue;
  entries.push({ no, paragraphs });
}

const body = entries
  .map((e) => `  { no: ${e.no}, paragraphs: [\n${e.paragraphs.map((p) => `    ${JSON.stringify(p)},`).join('\n')}\n  ] },`)
  .join('\n');

const file = `/**
 * 本文件由 scripts/gen-help-data.mjs 自动生成，请勿手工编辑。
 * 数据源：docs/gameplay/help_entries.txt（原版**繁体**中文说明，格式为 \`[NN] 正文@下一段\`）。
 * 生成时逐字转成简体（字表 tools/t2s-map.json）；源文件保持繁体原样，它是对得上原盘的凭据。
 * 重新生成：node scripts/gen-help-data.mjs
 */

/** 一条帮助条目：编号 + 正文分段（原文的 \`@\` 已拆成 paragraphs） */
export interface HelpEntry {
  no: number;
  paragraphs: string[];
}

export const HELP_ENTRIES: HelpEntry[] = [
${body}
];

/** 按编号区间归类，顺序即展示顺序 */
export const HELP_CATEGORIES: Array<{ key: string; label: string; from: number; to: number }> = [
  { key: 'basic', label: '基本操作', from: 1, to: 10 },
  { key: 'trade', label: '交易与资产', from: 11, to: 20 },
  { key: 'build', label: '建设与神明', from: 21, to: 30 },
  { key: 'event', label: '事件与 NPC', from: 31, to: 40 },
];

export const HELP_OTHER_LABEL = '其他';

/** 把条目按分类分组，「其他」兜底 */
export function groupHelpEntries(entries: HelpEntry[] = HELP_ENTRIES) {
  const groups = HELP_CATEGORIES.map((c) => ({ ...c, entries: [] as HelpEntry[] }));
  const other: HelpEntry[] = [];
  for (const entry of entries) {
    const bucket = groups.find((g) => entry.no >= g.from && entry.no <= g.to);
    if (bucket) bucket.entries.push(entry);
    else other.push(entry);
  }
  return { groups, other };
}
`;

writeFileSync(out, file, 'utf8');
console.log(`已生成 ${entries.length} 条帮助条目 -> ${out}`);