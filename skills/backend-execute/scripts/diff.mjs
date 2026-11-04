// Minimal unified diff (LCS-based). Good enough for reviewing config and source edits.

const MAX_CELLS = 4_000_000;

/**
 * @param {string|null} before null = file does not exist
 * @param {string|null} after null = file removed
 * @param {string} label path shown in the header
 * @param {number} [context]
 */
export function unifiedDiff(before, after, label, context = 3) {
  const a = splitLines(before);
  const b = splitLines(after);
  const header = [`--- ${before === null ? '/dev/null' : 'a/' + label}`, `+++ ${after === null ? '/dev/null' : 'b/' + label}`];
  if (before === after) return '';
  if (a.length * b.length > MAX_CELLS) return [...header, `@@ file too large to diff: ${a.length} → ${b.length} lines @@`].join('\n');

  // LCS table, then walk to produce ops.
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  /** @type {[' '|'-'|'+', string, number, number][]} op, line, index in a, index in b */
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([' ', a[i], i++, j++]);
    else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) ops.push(['-', a[i], i++, j]); // deletions first, like git
    else ops.push(['+', b[j], i, j++]);
  }

  const out = [...header];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; continue; }
    // Extend the hunk while changes are within 2*context of each other.
    let start = Math.max(0, k - context);
    let end = k;
    for (let last = k; end < ops.length; end++) {
      if (ops[end][0] !== ' ') last = end;
      else if (end - last > 2 * context) break;
    }
    end = Math.min(ops.length, end - (end < ops.length ? context : 0));
    const hunk = ops.slice(start, end);
    const aStart = hunk[0][2], bStart = hunk[0][3];
    const aLen = hunk.filter((o) => o[0] !== '+').length, bLen = hunk.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of hunk) out.push(o[0] + o[1]);
    k = end;
  }
  return out.join('\n');
}

/** @param {string|null} s */
function splitLines(s) {
  if (s === null || s === '') return [];
  const lines = s.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
