/** Fetches up to five pages through the host's proxy and returns a screenshot and the text of each. */
export const FETCH_IMAGE = 'charter-job-fetch';
/** Runs the renter's own Python script with no network and returns its stdout, stderr and exit code. */
export const PYTHON_IMAGE = 'charter-job-python';
/** A box the renter logs into over SSH; its only argument is the set of public keys that may. */
export const HOME_IMAGE = 'charter-home';
/** The same box with Hermes Agent preinstalled; a home in every way, so the key set stays its identity. */
export const HERMES_IMAGE = 'charter-hermes';
/** The images that are homes: a persistent disk and an SSH door. */
export const HOME_IMAGES = [HOME_IMAGE, HERMES_IMAGE];
/** Every job a renter can ask for. */
export const JOB_IMAGES = [FETCH_IMAGE, PYTHON_IMAGE, HOME_IMAGE, HERMES_IMAGE];
