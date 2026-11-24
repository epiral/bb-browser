/**
 * site adapter 参数解析
 *
 * 背景：`index.ts` 的全局 `parseArgs` 会丢弃未识别的 `--flag`（以及它后面那个值），
 * 导致 adapter 自己的 `--status FAIL` / `--head x` 这类参数根本传不到 adapter。
 * 所以 site 子命令改从原始 argv 里取参数，这里只负责把原始 token 解析成 adapter 需要的 map。
 *
 * 规则：
 * 1. 声明在 adapter meta 里的 `--flag`（如 `--head`）→ 取下一个 token 作为值
 * 2. CLI 自己的全局 flag（`--jq` / `--tab` / `--days` ...）→ 连值一起跳过，不能污染位置参数
 * 3. 其他未知 `--flag` / 短横线 flag → 忽略
 * 4. 其余 token → 按 adapter meta 里 args 的声明顺序填位置参数
 */

export interface SiteArgDef {
  required?: boolean;
  description?: string;
}

export type SiteArgsMeta = Record<string, SiteArgDef | undefined>;

/** CLI 层自己消费、且带一个值的全局 flag（site 运行时需要连值一起跳过） */
export const CLI_VALUE_FLAGS = new Set([
  "jq",
  "tab",
  "port",
  "days",
  "depth",
  "selector",
  "domain",
  "args",
  "since",
  "method",
  "status",
  "type",
  "filter",
  "limit",
  "request-id",
]);

/**
 * 把原始 argv token 解析成 adapter 参数表。
 *
 * @param rawArgs   adapter 名之后的原始 token（顺序保留，未被任何全局解析裁剪过）
 * @param argDefs   adapter meta 里的 args 声明（顺序即位置参数顺序）
 */
export function parseSiteArgs(rawArgs: string[], argDefs: SiteArgsMeta = {}): Record<string, string> {
  const named: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];

    if (token.startsWith("--")) {
      const flag = token.slice(2);
      if (flag in argDefs) {
        const next = rawArgs[i + 1];
        if (next !== undefined) {
          named[flag] = next;
          i++;
        }
        continue;
      }
      if (CLI_VALUE_FLAGS.has(flag)) {
        i++; // 跳过全局 flag 的值，避免它被当成位置参数
        continue;
      }
      continue; // 未知 flag：忽略
    }

    if (/^-[A-Za-z]/.test(token)) continue; // 短 flag（-i / -c / -h ...）：忽略

    positional.push(token);
  }

  const result: Record<string, string> = { ...named };
  let posIdx = 0;
  for (const argName of Object.keys(argDefs)) {
    if (result[argName] !== undefined) continue;
    if (posIdx >= positional.length) continue;
    result[argName] = positional[posIdx++];
  }
  return result;
}

/**
 * 没有 adapter meta 时的兜底解析：只认 `--key value`，不做位置参数映射。
 * （site 还没被 daemon 收录时仍要把参数透传过去，让 daemon 报出正确的错误）
 */
export function parseFlagPairs(rawArgs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) continue;
    const next = rawArgs[i + 1];
    if (next === undefined) continue;
    result[token.slice(2)] = next;
    i++;
  }
  return result;
}

/**
 * 从原始 argv 里取出某个 token 之后的全部参数。
 *
 * 例：argv = ["site", "isagentos/tasks", "--status", "FAIL"]
 *     sliceAfter(argv, "isagentos/tasks") => ["--status", "FAIL"]
 */
export function sliceAfter(argv: string[] | undefined, needle: string | undefined): string[] | undefined {
  if (!argv || !needle) return undefined;
  const idx = argv.indexOf(needle);
  if (idx < 0) return undefined;
  return argv.slice(idx + 1);
}
