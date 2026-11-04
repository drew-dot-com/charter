/** Fetches up to five pages through the host's proxy and returns a screenshot and the text of each. */
export const FETCH_IMAGE = 'charter-job-fetch';
/** Runs the renter's own Python script with no network and returns its stdout, stderr and exit code. */
export const PYTHON_IMAGE = 'charter-job-python';
/** A box the renter logs into over SSH; its only argument is the set of public keys that may. */
export const HOME_IMAGE = 'charter-home';
/** Every job a renter can ask for. */
export const JOB_IMAGES = [FETCH_IMAGE, PYTHON_IMAGE, HOME_IMAGE];
