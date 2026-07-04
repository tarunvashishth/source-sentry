export interface DiffResult {
  addedLines: number;
  removedLines: number;
  unified: string;
  truncated: boolean;
}

type Op = ["-" | "+" | " ", string];

const MAX_LINES = 6000; // per side, before diffing
// Max middle-section size for exact LCS. lcsDiff()'s DP table is a Uint16Array storing
// match-run lengths bounded by min(midA.length, midB.length) <= LCS_CAP — keep this
// under 65536 or the table silently wraps/corrupts instead of throwing.
const LCS_CAP = 1200;
const CONTEXT = 3;
const MAX_DIFF_CHARS = 16_000;

export function diffLines(oldText: string, newText: string): DiffResult {
  let truncated = false;
  let a = oldText.split("\n");
  let b = newText.split("\n");
  if (a.length > MAX_LINES) {
    a = a.slice(0, MAX_LINES);
    truncated = true;
  }
  if (b.length > MAX_LINES) {
    b = b.slice(0, MAX_LINES);
    truncated = true;
  }

  // Trim common prefix/suffix — doc changes are usually localized, which keeps
  // the exact-LCS middle small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let ops: Op[];
  if (midA.length === 0 && midB.length === 0) {
    ops = [];
  } else if (midA.length > LCS_CAP || midB.length > LCS_CAP) {
    // Too large for exact LCS within memory limits — emit as block replacement.
    ops = [...midA.map((l): Op => ["-", l]), ...midB.map((l): Op => ["+", l])];
  } else {
    ops = lcsDiff(midA, midB);
  }

  const addedLines = ops.filter((o) => o[0] === "+").length;
  const removedLines = ops.filter((o) => o[0] === "-").length;

  const parts: string[] = [];
  if (ops.length > 0) {
    parts.push(`@@ line ${start + 1} @@`);
    for (const line of a.slice(Math.max(0, start - CONTEXT), start)) {
      parts.push(`  ${line}`);
    }
    for (const [tag, line] of ops) {
      parts.push(tag === " " ? `  ${line}` : `${tag} ${line}`);
    }
    for (const line of a.slice(endA, Math.min(a.length, endA + CONTEXT))) {
      parts.push(`  ${line}`);
    }
  }

  let unified = "";
  for (const part of parts) {
    if (unified.length + part.length + 1 > MAX_DIFF_CHARS) {
      unified += "\n… diff truncated …";
      truncated = true;
      break;
    }
    unified += (unified ? "\n" : "") + part;
  }

  return { addedLines, removedLines, unified, truncated };
}

function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push(["-", a[i]]);
      i++;
    } else {
      ops.push(["+", b[j]]);
      j++;
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}
