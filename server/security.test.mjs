import assert from 'node:assert/strict';
import {
  FixedWindowRateLimiter,
  MAX_SIGNALING_MESSAGE_BYTES,
  SocketRateLimiter,
  normalizeInviteTtl,
  randomId,
  randomToken,
  tokenDigest,
  tokenMatches,
  validateClientMessage,
} from './security.mjs';

const invite = randomToken(32);
assert.match(invite, /^[A-Za-z0-9_-]{40,128}$/);
assert.equal(tokenMatches(invite, tokenDigest(invite)), true);
assert.equal(tokenMatches(randomToken(32), tokenDigest(invite)), false);

const peerId = randomId(18);
assert.match(peerId, /^[A-Za-z0-9_-]{20,64}$/);
assert.equal(normalizeInviteTtl(15), 15);
assert.equal(normalizeInviteTtl(123), 60);
assert.equal(MAX_SIGNALING_MESSAGE_BYTES, 96 * 1024);

assert.deepEqual(
  validateClientMessage({ type: 'invite-regenerate' }),
  { type: 'invite-regenerate' },
);

assert.deepEqual(
  validateClientMessage({
    type: 'signal',
    target: peerId,
    data: { candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } },
  }),
  {
    type: 'signal',
    target: peerId,
    data: { candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } },
  },
);

assert.throws(
  () => validateClientMessage({ type: 'leave', injected: true }),
  /campos não permitidos/,
);
assert.throws(
  () => validateClientMessage({ type: 'signal', target: peerId, from: randomId(18), data: { candidate: { candidate: '' } } }),
  /campos não permitidos/,
);
assert.throws(
  () => validateClientMessage({ type: 'unknown' }),
  /não suportado/,
);

const fixed = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000 });
assert.equal(fixed.consume('ip', 0).allowed, true);
assert.equal(fixed.consume('ip', 1).allowed, true);
assert.equal(fixed.consume('ip', 2).allowed, false);
assert.equal(fixed.consume('ip', 1001).allowed, true);

const socketLimiter = new SocketRateLimiter();
const socket = {};
assert.equal(socketLimiter.consume(socket, 'signal', { limit: 1, windowMs: 1000 }, 0).allowed, true);
assert.equal(socketLimiter.consume(socket, 'signal', { limit: 1, windowMs: 1000 }, 1).allowed, false);

console.log('security.test.mjs: OK');
