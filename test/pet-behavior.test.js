const test = require('node:test');
const assert = require('node:assert/strict');
const behavior = require('../pet-behavior');

const { ACTIVE_MS: TWO_MIN, STILL_MS: FIVE_MIN, frameFor } = behavior;

test('normal three-frame animation continues until two minutes without cursor activity', () => {
  assert.equal(frameFor('idle', TWO_MIN - 1, 2), 2);
  assert.equal(frameFor('joy', TWO_MIN - 1, 1), 1);
});

test('two-minute idle frame loops use the requested frame selections', () => {
  const firstFrames = { idle: 0, joy: 0, affection: 0, tired: 1, eating: 0, curious: 0, angry: 0, sad: 1, sick: 2, magic: 1 };
  for (const [mood, frame] of Object.entries(firstFrames)) assert.equal(frameFor(mood, TWO_MIN, 2), frame, mood);
  assert.equal(frameFor('idle', TWO_MIN + 1250), 1);
  assert.equal(frameFor('affection', TWO_MIN + 1250), 1);
  assert.equal(frameFor('eating', TWO_MIN + 1250), 1);
  assert.equal(frameFor('curious', TWO_MIN + 1250), 2);
  assert.equal(frameFor('tired', TWO_MIN + 1800), 2);
  assert.equal(frameFor('joy', TWO_MIN + 15000), 1);
  assert.equal(frameFor('angry', TWO_MIN + 5000), 1);
  assert.equal(frameFor('sad', TWO_MIN + 30000), 1);
  assert.equal(frameFor('magic', TWO_MIN + 30000), 1);
});

test('sick mood holds frame three for two idle minutes, then frame one', () => {
  assert.equal(frameFor('sick', TWO_MIN, 0), 2);
  assert.equal(frameFor('sick', TWO_MIN + TWO_MIN - 1, 0), 2);
  assert.equal(frameFor('sick', TWO_MIN + TWO_MIN, 0), 0);
});

test('five-minute resting poses match the requested frames', () => {
  const restingFrames = { idle: 2, joy: 2, affection: 1, tired: 2, eating: 0, curious: 1, angry: 1, sad: 0, sick: 1, magic: 1 };
  for (const [mood, frame] of Object.entries(restingFrames)) assert.equal(frameFor(mood, FIVE_MIN, 0), frame, mood);
});

test('animation timer stops frame changes when resting and wakes on cursor activity', () => {
  assert.equal(behavior.nextDelay('idle', FIVE_MIN), 60000);
  assert.equal(frameFor('idle', 0, 2), 2);
  assert.equal(behavior.nextDelay('idle', TWO_MIN - 100), 100);
  assert.equal(behavior.nextDelay('sick', TWO_MIN + 30000), 90000);
});
