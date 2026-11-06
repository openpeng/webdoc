/**
 * Fiddler SAZ（HTTPArchive）归档解码 —— **纯内存**解析层。
 *
 * SAZ 是 Fiddler 导出的真实流量归档（一个 ZIP 包），与 HAR 同一路：
 * 包内是逐会话的原始 HTTP 报文（`raw/N_c.txt` / `raw/N_s.txt`）或 HTTP XML
 * 会话（`N_c.xml` / `N_s.xml`），外加 `_index.htm` 与 `meta/`。
 *
 * 硬约束（与 api-command-site-scan.ts 同款纪律）：
 *  - **不 import node:fs**、不做网络请求、不读 Date.now()、不读环境变量；
 *  - 只用 node:zlib 的 `inflateRawSync` 做「字节 → 字节」解压 —— 确定性纯函数，
 *    没有文件系统与网络参与，因此本模块可被 `node --test` 直接单测；
 *  - 解压有配额上限（条目数 / 单条字节 / 总量），畸形或恶意归档只会**少解析**，
 *    不会让进程失控。
 *
 * 为什么不直接用 fs 读 .saz：解析侧一旦引入文件 IO，就无法被 node --test 直测，
 * 也无法在无本地文件的环境（远端 MCP Server）里复用同一份解析逻辑。
 * 归档内容由调用方以 **base64 文本**形式喂进来（见 decodeSazArchive）。
 */
import { inflateRawSync } from "node:zlib";
import {
  SITE_SCAN_SAZ_MAX_ENTRIES,
  SITE_SCAN_SAZ_MAX_ENTRY_BYTES,
  SITE_SCAN_SAZ_MAX_TOTAL_BYTES,
} from "./api-command-types.js";

/** ZIP 中央目录结束记录（End of Central Directory）签名。 */
const EOCD_SIGNATURE = 0x06054b50;
/** ZIP 中央目录文件头签名。 */
const CENTRAL_SIGNATURE = 0x02014b50;
/** ZIP 本地文件头签名。 */
const LOCAL_SIGNATURE = 0x04034b50;
/** ZIP64 占位尺寸：本模块不解 ZIP64，遇到即跳过该条目。 */
const ZIP64_MARKER = 0xffffffff;

export interface SazEntry {
  /** 归档内条目名（如 `raw/1_c.txt`）。 */
  name: string;
  /** 条目内容（按 UTF-8 解码；二进制条目可能含替换字符，解析时会被忽略）。 */
  text: string;
}

export interface SazArchiveResult {
  /** 是否成功解出条目（false 表示输入不是可识别的 ZIP 归档）。 */
  ok: boolean;
  entries: SazEntry[];
  /** 失败原因（固定短语，不回显任何条目内容）。 */
  error?: string;
}

/**
 * 判断一段文本是否可能是 base64 编码的 ZIP 归档。
 *
 * 「PK\x03\x04」是 ZIP 本地文件头魔数，其 base64 前缀恒为 "UEsD"。
 */
export function looksLikeSazArchive(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  if (value.startsWith("UEsD")) return true;
  if (value.startsWith("PK\u0003\u0004")) return true;
  return false;
}

/** base64 → 字节（宽容解码：忽略空白与非法字符）。 */
function decodeBase64(text: string): Buffer | undefined {
  const compact = text.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/=]+$/.test(compact)) return undefined;
  try {
    const buf = Buffer.from(compact, "base64");
    return buf.length > 0 ? buf : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解码 SAZ 归档（base64 或原始二进制文本）。
 *
 * 只支持 ZIP 的 **store（0）** 与 **deflate（8）** 两种压缩方式 —— Fiddler 导出的
 * SAZ 就是这两种；其余方式（bzip2 / lzma 等）跳过该条目而不是整体失败。
 */
export function decodeSazArchive(text: string): SazArchiveResult {
  const raw = String(text || "");
  if (!raw.trim()) return { ok: false, entries: [], error: "empty" };
  const trimmed = raw.trim();
  let buf: Buffer | undefined;
  if (trimmed.startsWith("UEsD")) {
    buf = decodeBase64(trimmed);
  } else if (trimmed.startsWith("PK\u0003\u0004")) {
    // 已经是原始字节（ latin1 一一对应 ），直接还原。
    buf = Buffer.from(trimmed, "latin1");
  }
  if (!buf || buf.length < 22) return { ok: false, entries: [], error: "not-a-zip" };

  // 1) 定位 EOCD：签名 0x06054b50，从尾部往前找（注释最长 65535 字节）。
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= scanStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, entries: [], error: "no-eocd" };

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_MARKER || cdOffset >= buf.length) {
    return { ok: false, entries: [], error: "unsupported-zip64" };
  }

  const entries: SazEntry[] = [];
  let pos = cdOffset;
  let totalBytes = 0;
  const maxEntries = Math.min(entryCount || SITE_SCAN_SAZ_MAX_ENTRIES, SITE_SCAN_SAZ_MAX_ENTRIES);
  for (let index = 0; index < maxEntries; index += 1) {
    if (pos + 46 > buf.length) break;
    if (buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    // 目录条目 / ZIP64 / 越界：跳过，不影响其它条目。
    if (name.endsWith("/")) continue;
    if (compSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) continue;
    if (localOffset + 30 > buf.length) continue;
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) continue;

    let content: Buffer;
    if (method === 0) {
      content = buf.subarray(dataStart, dataStart + compSize);
    } else if (method === 8) {
      try {
        content = inflateRawSync(buf.subarray(dataStart, dataStart + compSize));
      } catch {
        continue;
      }
    } else {
      continue;
    }
    if (content.length > SITE_SCAN_SAZ_MAX_ENTRY_BYTES) continue;
    totalBytes += content.length;
    if (totalBytes > SITE_SCAN_SAZ_MAX_TOTAL_BYTES) break;
    entries.push({ name, text: content.toString("utf8") });
  }

  return { ok: true, entries };
}
