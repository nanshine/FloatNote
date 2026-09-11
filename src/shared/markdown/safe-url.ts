/** URLs accepted by editor nodes and the guarded Rust open-url boundary. */
export function isSafeUrl(url: string): boolean {
  const value = url.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/|floatnote-img:)/i.test(value)) return true;
  // Markdown commonly stores project-local images as `_assets/a.png` without
  // a leading `./`. Accept relative paths while rejecting every unrecognised
  // URI scheme (javascript:, data:, vbscript:, file:, and similar).
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return /^[a-z]:[\\/]/i.test(value);
  return !value.startsWith("//");
}
