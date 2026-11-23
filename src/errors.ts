/** The least time a send with a deadline is given. Closer to its deadline than this, it is not sent. */
export const MIN_SEND_MS = 5_000;

/** A send skipped because its deadline was too close: nothing was sent and nothing paid. */
export class DeadlinePassedError extends Error {
  constructor() {
    super('send deadline passed');
    this.name = 'DeadlinePassedError';
  }
}

/** A send that got no answer in time. It may or may not have been paid. */
export class SendTimeoutError extends Error {
  constructor() {
    super('send timed out');
    this.name = 'SendTimeoutError';
  }
}
