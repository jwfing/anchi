// Shown before a user lets agents publish without asking: the TUI, the CLI and the desktop app.

/** What `auto` for X or Reddit gives up, said before it is set. */
export function autoPublishWarning(id: 'x' | 'reddit'): string {
  return (
    `Agents with ${id} then post to ${id === 'x' ? 'X' : 'Reddit'} publicly under your account ` +
    'without asking you, also in tasks a trigger starts and that read untrusted content ' +
    '(mentions, issues, mail, web pages): instructions in that content can make them post. ' +
    `Agents whose file says approvals: {${id}: ask} still ask.`
  );
}
