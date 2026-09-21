// Wire limits shared with services/common.py LIMITS and desktop/src/shared/protocol.cjs LIMITS.
// A cross-language test asserts the three copies stay identical.
export const LIMITS = Object.freeze({
  rpc_bytes: 65536,
  prompt_chars: 8000,
  host_file_text_bytes: 24000,
});
