/**
 * Machine-parsable error codes (spec §10). Every tool failure surfaces one of
 * these plus a human sentence so the model can self-correct.
 */
export const Codes = {
  STORAGE_NOT_GRANTED: 'STORAGE_NOT_GRANTED',
  PATH_ESCAPE: 'PATH_ESCAPE',
  NOT_FOUND: 'NOT_FOUND',
  BATCH_LIMIT: 'BATCH_LIMIT',
  PROTECTED_MATCH: 'PROTECTED_MATCH',
  TRASH_CONFIRM_REQUIRED: 'TRASH_CONFIRM_REQUIRED',
  INVALID_INPUT: 'INVALID_INPUT',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  INTERNAL: 'INTERNAL'
};

export class JanitorError extends Error {
  /**
   * @param {string} code one of Codes
   * @param {string} message a human sentence, safe to show the user
   * @param {object} [details] extra machine-readable context
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'JanitorError';
    this.code = code;
    if (details) this.details = details;
  }
}

/** Convenience: the error every entry point throws when the storage grant is missing. */
export function storageNotGranted(root) {
  return new JanitorError(
    Codes.STORAGE_NOT_GRANTED,
    `Shared storage is not reachable at ${root}. Run 'termux-setup-storage' in Termux and approve the permission dialog, then restart the session.`,
    { root }
  );
}
