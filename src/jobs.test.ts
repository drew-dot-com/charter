import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_IMAGE, JOB_IMAGES, MAX_SCRIPT_BYTES, MAX_URLS, PYTHON_IMAGE, fetchJob, isScript, jobFromBody, pythonJob } from './jobs.js';

test('the two job images are the only ones a renter can ask for', () => {
  assert.deepEqual(JOB_IMAGES, ['charter-job-fetch', 'charter-job-python']);
  assert.deepEqual(fetchJob(['https://a.com', 'http://b.com/x?y=1']), { image: FETCH_IMAGE, args: { URLS: 'https://a.com,http://b.com/x?y=1' } });
  assert.deepEqual(pythonJob('print(1)'), { image: PYTHON_IMAGE, args: { SCRIPT: 'print(1)' } });
});

test('jobFromBody: { urls } is a fetch job of 1 to 5 http(s) URLs with no comma', () => {
  assert.deepEqual(jobFromBody({ urls: ['https://a.com'] }), fetchJob(['https://a.com']));
  const five = Array.from({ length: MAX_URLS }, (_, i) => `https://e${i}.com/`);
  assert.deepEqual(jobFromBody({ urls: five }), fetchJob(five));
  for (const [why, urls] of [
    ['empty', []],
    ['six', [...five, 'https://f.com']],
    ['not an array', 'https://a.com'],
    ['an object', { 0: 'https://a.com' }],
    ['ftp', ['ftp://a.com']],
    ['no scheme', ['a.com']],
    ['not a url', ['not a url']],
    ['a comma, which would split the job arg', ['https://a.com/x,y']],
    ['over 2000 chars', ['https://a.com/' + 'x'.repeat(2000)]],
    ['a number among them', ['https://a.com', 5]],
    ['null among them', ['https://a.com', null]],
    ['javascript', ['javascript:alert(1)']],
    ['data', ['data:text/html,hi']],
  ] as const) {
    assert.equal(jobFromBody({ urls }), null, why);
  }
});

test('jobFromBody: { python: { script } } is a python job of a non-blank script up to 8 KiB with no NUL', () => {
  assert.deepEqual(jobFromBody({ python: { script: 'print("hi")' } }), pythonJob('print("hi")'));
  const max = 'x'.repeat(MAX_SCRIPT_BYTES);
  assert.deepEqual(jobFromBody({ python: { script: max } }), pythonJob(max));
  for (const [why, python] of [
    ['blank', { script: '   \n' }],
    ['empty', { script: '' }],
    ['one byte over, counted in UTF-8', { script: 'é' + 'x'.repeat(MAX_SCRIPT_BYTES - 1) }],
    ['a NUL', { script: 'print(1)\0' }],
    ['not a string', { script: 5 }],
    ['no script', {}],
    ['python not an object', 'print(1)'],
    ['python null', null],
    ['python an array', [{ script: 'print(1)' }]],
  ] as const) {
    assert.equal(jobFromBody({ python: python as never }), null, why);
  }
  assert.equal(isScript('x'.repeat(MAX_SCRIPT_BYTES + 1)), false);
  assert.equal(isScript('ok'), true);
});

test('jobFromBody: neither or both job shapes is null, and other keys are ignored', () => {
  assert.equal(jobFromBody({}), null);
  assert.equal(jobFromBody({ urls: ['https://a.com'], python: { script: 'print(1)' } }), null, 'exactly one of the two');
  assert.equal(jobFromBody({ urls: undefined, python: undefined }), null);
  assert.deepEqual(jobFromBody({ urls: ['https://a.com'], python: undefined }), fetchJob(['https://a.com']));
  assert.deepEqual(jobFromBody({ offerId: 'x', urls: ['https://a.com'] } as { urls: string[] }), fetchJob(['https://a.com']));
  // A prototype-less or odd object is read by its own keys only.
  assert.equal(jobFromBody(Object.create(null) as Record<string, never>), null);
});
