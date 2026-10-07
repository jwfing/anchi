/**
 * Agent-originated text is untrusted. Before anything reaches the terminal, remove every escape
 * sequence (CSI, OSC — including OSC 8 links and OSC 52 clipboard writes — DCS, APC, PM, SOS),
 * C0 and C1 control characters other than newline and tab, and bidirectional overrides that can
 * make text read differently from what it is.
 */
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)|[@-Z\\-_]|.?)/g;
// eslint-disable-next-line no-control-regex
const C1_SEQUENCES =
  /[\u009b][0-?]*[ -/]*[@-~]|[\u009d\u0090\u0098\u009e\u009f][\s\S]*?(?:\u0007|\u009c|$)/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ESCAPE_SEQUENCES, '')
    .replace(C1_SEQUENCES, '')
    .replace(CONTROLS, '')
    .replace(BIDI, '');
}

/** One-line form for lists and headers: whitespace collapsed. */
export function sanitizeLine(text: string): string {
  return sanitize(text).replace(/\s+/g, ' ').trim();
}
