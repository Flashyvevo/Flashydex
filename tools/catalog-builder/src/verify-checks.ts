/** Returns a description of every check field that is false (empty array = all good). */
export function failedChecks(results: ReadonlyArray<Record<string, unknown>>): string[] {
  const failed: string[] = [];
  for (const result of results) {
    const language = String(result.language ?? '?');
    for (const field of ['shaMatches', 'bytesMatch', 'countsMatch', 'compressedShaMatches', 'compressedBytesMatch', 'fullPackUrlMatches', 'metaMatches']) {
      if (result[field] !== true) failed.push(`${language}.${field}`);
    }
    if (result.integrity !== 'ok') failed.push(`${language}.integrity`);
    if (result.foreignKeyViolations !== 0) failed.push(`${language}.foreignKeyViolations`);
    const live = Array.isArray(result.liveChecks) ? (result.liveChecks as Array<{ id?: string; ok?: boolean }>) : [];
    if (live.length === 0) failed.push(`${language}.liveChecks(empty)`);
    for (const check of live) if (check.ok !== true) failed.push(`${language}.liveChecks[${check.id ?? '?'}]`);
  }
  return failed;
}
