// Chromium flags for the fetch job. Kept apart from fetch.mjs (which needs Playwright) so they can be tested.

/**
 * WebRTC may send UDP straight from the container, around the SOCKS proxy, and tell a page the host's
 * address. Both policy flags keep it to proxied paths only: one is honoured by older builds, the other
 * forces the policy over any page or preference.
 */
export function chromiumArgs() {
  return [
    '--disable-dev-shm-usage',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}
