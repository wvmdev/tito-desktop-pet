(function attachAuraBehavior(root, factory) {
  const behavior = factory();
  if (typeof module === 'object' && module.exports) module.exports = behavior;
  else root.AuraBehavior = behavior;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAuraBehavior() {
  const ACTIVE_MS = 2 * 60 * 1000;
  const STILL_MS = 5 * 60 * 1000;
  const IDLE_FRAMES = Object.freeze({
    idle: [0, 1], joy: [0, 1], affection: [0, 1], tired: [1, 2],
    eating: [0, 1], curious: [0, 2], angry: [0, 1], sad: [1],
    sick: [2], magic: [1]
  });
  const STILL_FRAMES = Object.freeze({
    idle: 2, joy: 2, affection: 1, tired: 2, eating: 0,
    curious: 1, angry: 1, sad: 0, sick: 1, magic: 1
  });
  const NORMAL_INTERVAL_MS = Object.freeze({ joy: 760, tired: 1800, magic: 1050 });
  const IDLE_INTERVAL_MS = Object.freeze({ joy: 15000, angry: 5000, tired: 1800 });

  function normalInterval(mood) { return NORMAL_INTERVAL_MS[mood] || 1250; }

  function frameFor(mood, idleMs, activeFrame = 0) {
    if (idleMs < ACTIVE_MS) return activeFrame;
    if (idleMs >= STILL_MS) return STILL_FRAMES[mood] ?? 0;
    const elapsedAfterIdle = idleMs - ACTIVE_MS;
    if (mood === 'sick') return elapsedAfterIdle < ACTIVE_MS ? 2 : 0;
    const frames = IDLE_FRAMES[mood] || [0, 1, 2];
    if (frames.length === 1) return frames[0];
    const interval = IDLE_INTERVAL_MS[mood] || normalInterval(mood);
    return frames[Math.floor(elapsedAfterIdle / interval) % frames.length];
  }

  function nextDelay(mood, idleMs) {
    if (idleMs >= STILL_MS) return 60000; // Keep speech bubbles alive while the sprite stays still.
    if (idleMs < ACTIVE_MS) return Math.min(normalInterval(mood), ACTIVE_MS - idleMs);
    const elapsedAfterIdle = idleMs - ACTIVE_MS;
    if (mood === 'sick' && elapsedAfterIdle < ACTIVE_MS) {
      return Math.min(ACTIVE_MS - elapsedAfterIdle, STILL_MS - idleMs);
    }
    const frames = IDLE_FRAMES[mood] || [0, 1, 2];
    if (frames.length === 1) return STILL_MS - idleMs;
    const interval = IDLE_INTERVAL_MS[mood] || normalInterval(mood);
    return Math.min(interval - (elapsedAfterIdle % interval), STILL_MS - idleMs);
  }

  return Object.freeze({ ACTIVE_MS, STILL_MS, IDLE_FRAMES, STILL_FRAMES, normalInterval, frameFor, nextDelay });
});
