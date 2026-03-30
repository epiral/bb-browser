interface ParseSuccess<T> {
  ok: true;
  value: T;
}

interface ParseFailure {
  ok: false;
  error: Error;
}

function buildPreview(raw: string): string {
  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
}

function tryParseJson<T>(raw: string): ParseSuccess<T> | ParseFailure {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function tryParseLastJsonLineBlock<T>(raw: string): ParseSuccess<T> | null {
  const lines = raw.split(/\r?\n/);

  // OpenClaw diagnostics are emitted as extra lines around the JSON payload,
  // so prefer the last contiguous block of lines that parses cleanly as JSON.
  for (let end = lines.length; end > 0; end -= 1) {
    for (let start = end - 1; start >= 0; start -= 1) {
      const candidate = lines.slice(start, end).join("\n").trim();
      if (!candidate) {
        continue;
      }

      const parsed = tryParseJson<T>(candidate);
      if (parsed.ok) {
        return parsed;
      }
    }
  }

  return null;
}

export function parseOpenClawJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("OpenClaw returned empty output");
  }

  const direct = tryParseJson<T>(trimmed);
  if (direct.ok) {
    return direct.value;
  }

  const lineBlock = tryParseLastJsonLineBlock<T>(trimmed);
  if (lineBlock) {
    return lineBlock.value;
  }

  throw new Error(`Failed to parse OpenClaw JSON output: ${direct.error.message}\nRaw (preview): ${buildPreview(trimmed)}`);
}
