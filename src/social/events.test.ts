import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEvents, impliedSeen } from './events.js';
import type { Sources } from './sources.js';

const cfg = { firstParty: new Set(['0xfund']), probes: new Set(['0xprobe']) };
const none = new Set<string>();
const lease = (o: Record<string, unknown>) => ({ leaseId: 'L1', payer: '0xrenter', ticksPaidByRenter: 1, createdAt: 100, offer: { intervalSeconds: 3600 }, ...o });
/** A lease paid every 600 s: six ticks make an hour. */
const short = (o: Record<string, unknown>) => lease({ offer: { intervalSeconds: 600 }, ...o });
const src = (o: Partial<Record<keyof Sources, unknown[]>>): Sources =>
  ({ leases: [], grants: [], hosts: [], tickTxs: [], ...o }) as unknown as Sources;

test('one paid hour from an outside wallet is not an event', () => {
  assert.deepEqual(detectEvents(src({ leases: [lease({})] }), none, cfg), []);
});

test('a second paid hour is renter_returned', () => {
  const ev = detectEvents(src({ leases: [lease({ ticksPaidByRenter: 2, lastTickAt: 500 })] }), none, cfg);
  assert.deepEqual(ev, [{ id: 'returned:L1', kind: 'renter_returned', at: 500, leaseId: 'L1', payer: '0xrenter', hoursPaid: 2 }]);
});

test('a PROBE_PAYERS wallet never yields renter_returned or milestone', () => {
  for (const h of [2, 24, 1000]) {
    assert.deepEqual(detectEvents(src({ leases: [lease({ payer: '0xProbe', ticksPaidByRenter: h })] }), none, cfg), []);
  }
});

test('a FIRST_PARTY_PAYERS lease yields nothing', () => {
  assert.deepEqual(detectEvents(src({ leases: [lease({ payer: '0xFUND', ticksPaidByRenter: 30 })] }), none, cfg), []);
});

test('a lease with no payer yields nothing', () => {
  assert.deepEqual(detectEvents(src({ leases: [lease({ payer: undefined, ticksPaidByRenter: 30 })] }), none, cfg), []);
});

test('a lease named on a grant is a grant lease', () => {
  const grants = [{ grantId: 'G1', state: 'active', leaseId: 'L1', updatedAt: 1 }];
  const ev = detectEvents(src({ leases: [lease({ payer: '0xfund', ticksPaidByRenter: 24 })], grants }), new Set(['grant:G1']), cfg);
  assert.deepEqual(ev, [{ id: 'milestone:L1:24', kind: 'milestone', at: 100, leaseId: 'L1', hours: 24, grantId: 'G1' }]);
});

test('milestones fire at 24, 100, 500, 1000', () => {
  for (const h of [24, 100, 500, 1000]) {
    const ev = detectEvents(src({ leases: [lease({ ticksPaidByRenter: h })] }), new Set(['returned:L1']), cfg);
    assert.deepEqual(ev.map((e) => e.id), [`milestone:L1:${h}`]);
  }
  assert.deepEqual(detectEvents(src({ leases: [lease({ ticksPaidByRenter: 23 })] }), new Set(['returned:L1']), cfg), []);
});

test('a lease that jumped from 20 to 120 hours yields only milestone 100', () => {
  const ev = detectEvents(src({ leases: [lease({ ticksPaidByRenter: 120 })] }), new Set(['returned:L1']), cfg);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.id, 'milestone:L1:100');
  assert.deepEqual(impliedSeen(ev[0]!), ['milestone:L1:24']);
});

test('impliedSeen is empty for non-milestone events and for the lowest milestone', () => {
  assert.deepEqual(impliedSeen({ id: 'host:h', kind: 'host_listed', at: 1, hostId: 'h' }), []);
  assert.deepEqual(impliedSeen({ id: 'milestone:L:24', kind: 'milestone', at: 1, leaseId: 'L', hours: 24 }), []);
});

test('grant approved = state not in queued/declined; declined and queued are not events', () => {
  const grants = ['queued', 'declined', 'approved_waiting', 'active', 'completed'].map((state, i) => ({
    grantId: `G${i}`, state, updatedAt: 10 + i, ...(state === 'active' ? { decidedAt: 3 } : {}),
  }));
  const ev = detectEvents(src({ grants }), none, cfg);
  assert.deepEqual(ev.map((e) => [e.id, e.at]), [['grant:G3', 3], ['grant:G2', 12], ['grant:G4', 14]]);
});

test('host_listed when probes.passed > 0, once per host id; a host with no passed probe is not an event', () => {
  const hosts = [
    { hostId: 'a', registeredAt: 5, probes: { passed: 1, lastAt: 50 } },
    { hostId: 'b', registeredAt: 6, probes: { passed: 0, failed: 2 } },
    { hostId: 'c', registeredAt: 7, probes: { passed: 2 } },
  ];
  const ev = detectEvents(src({ hosts }), none, cfg);
  assert.deepEqual(ev.map((e) => [e.id, e.at]), [['host:c', 7], ['host:a', 50]]);
  assert.deepEqual(detectEvents(src({ hosts }), new Set(['host:a', 'host:c']), cfg), []);
});

test('seen ids are never returned again', () => {
  const s = src({
    leases: [lease({ ticksPaidByRenter: 24 })],
    grants: [{ grantId: 'G', state: 'active', updatedAt: 1 }],
  });
  assert.equal(detectEvents(s, none, cfg).length, 3);
  assert.deepEqual(detectEvents(s, new Set(['returned:L1', 'milestone:L1:24', 'grant:G']), cfg), []);
});

test('a grant lease whose payer is in PROBE_PAYERS yields nothing', () => {
  const grants = [{ grantId: 'G1', state: 'active', leaseId: 'L1', updatedAt: 1 }];
  const ev = detectEvents(src({ leases: [lease({ payer: '0xProbe', ticksPaidByRenter: 30 })], grants }), new Set(['grant:G1']), cfg);
  assert.deepEqual(ev, []);
});

test('a 600 s lease: the second paid tick is renter_returned with hours as whole hours paid', () => {
  const ev = detectEvents(src({ leases: [short({ ticksPaidByRenter: 2, lastTickAt: 500 })] }), none, cfg);
  assert.deepEqual(ev, [{ id: 'returned:L1', kind: 'renter_returned', at: 500, leaseId: 'L1', payer: '0xrenter', hoursPaid: 0 }]);
  const later = detectEvents(src({ leases: [short({ ticksPaidByRenter: 13, lastTickAt: 500 })] }), none, cfg);
  assert.equal((later[0] as { hoursPaid: number }).hoursPaid, 2);
});

test('a 600 s lease reaches milestones by hours, not ticks', () => {
  const seen = new Set(['returned:L1']);
  assert.deepEqual(detectEvents(src({ leases: [short({ ticksPaidByRenter: 24 })] }), seen, cfg), [], '24 ticks are 4 hours');
  assert.deepEqual(detectEvents(src({ leases: [short({ ticksPaidByRenter: 143 })] }), seen, cfg), []);
  assert.deepEqual(detectEvents(src({ leases: [short({ ticksPaidByRenter: 144 })] }), seen, cfg).map((e) => e.id), ['milestone:L1:24']);
  assert.deepEqual(detectEvents(src({ leases: [short({ ticksPaidByRenter: 600 })] }), seen, cfg).map((e) => e.id), ['milestone:L1:100']);
});

test('a lease with no usable interval counts no hours', () => {
  const seen = new Set(['returned:L1']);
  assert.deepEqual(detectEvents(src({ leases: [lease({ ticksPaidByRenter: 500, offer: undefined })] }), seen, cfg), []);
});
