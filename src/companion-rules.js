// Companion rules: bond, hunger and petting. Pure functions (no Electron, no I/O) so they are easy to test.
//
//   bond   0..100   grows when you pet or feed him, fades slowly if you are away for days
//   hunger 0..1     grows with the time since he last ate (empty after 8 hours)
const HOUR = 3600 * 1000;
const FULL_AFTER = 8 * HOUR;   // hunger reaches 1 after this long without food
const PET_COOLDOWN = 10 * 1000; // only one pet in this time counts towards the bond
const FEED_MIN_HUNGER = 0.15;  // he turns down food when he is not hungry at all

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function hunger(lastFed, now = Date.now()) {
  if (!lastFed) return 0;
  return clamp((now - lastFed) / FULL_AFTER, 0, 1);
}
function hungerLabel(h) {
  return h < 0.35 ? 'Full' : h < 0.65 ? 'Fine' : h < 0.85 ? 'Hungry' : 'Starving';
}

const TIERS = [
  { id: 'new', label: 'New friends', min: 0 },
  { id: 'friends', label: 'Friends', min: 15 },
  { id: 'buddies', label: 'Buddies', min: 40 },
  { id: 'best', label: 'Best friends', min: 70 },
];
function bondTier(bond) {
  let t = TIERS[0];
  for (const x of TIERS) if (bond >= x.min) t = x;
  return t;
}

// A pet (a click on him). Returns the new bond and whether it counted.
function pet(bond, lastPetAt, now = Date.now()) {
  if (lastPetAt && now - lastPetAt < PET_COOLDOWN) return { bond, counted: false };
  return { bond: clamp(bond + 1, 0, 100), counted: true };
}

// Offer food. Not hungry -> he refuses and nothing changes.
function feed(bond, lastFed, now = Date.now()) {
  if (hunger(lastFed, now) < FEED_MIN_HUNGER) return { ok: false, bond, lastFed, reason: 'He is not hungry right now.' };
  return { ok: true, bond: clamp(bond + 3, 0, 100), lastFed: now };
}

// Days away fade the bond: nothing for the first day, then 1 point per day.
function decay(bond, lastSeen, now = Date.now()) {
  if (!lastSeen) return bond;
  const days = Math.floor((now - lastSeen) / (24 * HOUR));
  return clamp(bond - Math.max(0, days - 1), 0, 100);
}

// The closer you are, the more often he walks to your mouse pointer (base chance 1 in 5).
function mouseChance(bond, base = 0.2) { return clamp(base * (1 + bond / 100), 0, 0.45); }

// Cursor near him: how he reacts. speed in px/s, distance in px (already scaled to his size).
// Returns 'shy' | 'play' | null. A friend startles less and plays more.
function cursorReaction({ distance, speed, bond = 0 }) {
  if (distance > 90) return null;
  const shyAbove = 700 + bond * 12;      // a quick swipe at him
  if (speed > shyAbove) return 'shy';
  if (speed > 25 && speed < 450) return 'play'; // slowly wiggling beside him
  return null;
}

module.exports = {
  HOUR, FULL_AFTER, PET_COOLDOWN, FEED_MIN_HUNGER, TIERS,
  hunger, hungerLabel, bondTier, pet, feed, decay, mouseChance, cursorReaction,
};
