import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromiumArgs } from './launch.mjs';

test('F-C4: Chromium keeps WebRTC off any UDP path that bypasses the proxy, so a page cannot learn the host IP', () => {
  const args = chromiumArgs();
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'), args.join(' '));
  assert.ok(args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'), args.join(' '));
  assert.ok(args.includes('--disable-dev-shm-usage'));
});
