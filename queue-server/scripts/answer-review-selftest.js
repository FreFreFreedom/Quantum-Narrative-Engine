// The second reader with fake models: no network, no credits.
import assert from 'node:assert/strict';
import { reviewAnswer, wordFaults } from '../server/src/services/answerReview.js';

const countWords = (t) => String(t).split(/\s+/).filter(Boolean).length;
const long = (s) => Array(40).fill(s).join(' ');
const good = long('A feeling is understood where feelings live and ache together.');
const bad = long('This is the exact shape of a state closing its borders.');

let rewrites = 0;
const rewrite = async () => { rewrites += 1; return { text: good }; };

// KEEP and clean: untouched, no rewrite spent.
let r = await reviewAnswer({ question: 'q', answer: good, read: async () => ({ text: 'KEEP' }), rewrite, countWords });
assert.equal(r.changed, false); assert.equal(rewrites, 0);

// A fault named by the reader: rewritten.
r = await reviewAnswer({ question: 'q', answer: bad, read: async () => ({ text: '1. "a state closing its borders"' }), rewrite, countWords });
assert.equal(r.changed, true); assert.equal(r.text, good);

// Reader said KEEP but a banned phrase is there: still rewritten.
r = await reviewAnswer({ question: 'q', answer: bad, read: async () => ({ text: 'KEEP' }), rewrite, countWords });
assert.equal(r.changed, true);

// Reader fails: the word check alone decides; clean answer stays.
r = await reviewAnswer({ question: 'q', answer: good, read: async () => { throw new Error('down'); }, rewrite, countWords });
assert.equal(r.changed, false);

// A short or broken rewrite never replaces the original.
r = await reviewAnswer({ question: 'q', answer: bad, read: async () => ({ text: '1. x' }), rewrite: async () => ({ text: 'short' }), countWords });
assert.equal(r.text, bad.trim());
r = await reviewAnswer({ question: 'q', answer: bad, read: async () => ({ text: '1. x' }), rewrite: async () => { throw new Error('x'); }, countWords });
assert.equal(r.text, bad.trim());

// Short answers are not read at all.
r = await reviewAnswer({ question: 'q', answer: 'Yes.', read: async () => { throw new Error('should not run'); }, rewrite, countWords });
assert.equal(r.reviewed, false);

// His own words are not borrowed words.
assert.deepEqual(wordFaults('the grammar of film', 'what is the grammar of film?'), []);
assert.deepEqual(wordFaults('we metabolize grief'), ['metabolize']);
console.log('answer-review selftest: ok');
