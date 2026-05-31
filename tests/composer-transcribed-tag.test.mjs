import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prependTranscribedTag } from '../public/composer.js';

// The composer adds the <transcribed> marker only at send time, and only when
// the draft actually contains dictated text. These cases pin that contract.

test('prepends the <transcribed> tag when the draft contains dictated text', () => {
  assert.equal(
    prependTranscribedTag('fix the login bug', true),
    '<transcribed>\nfix the login bug',
  );
});

test('leaves the message untouched when no dictation contributed', () => {
  assert.equal(prependTranscribedTag('hand-typed message', false), 'hand-typed message');
});

test('is a no-op on an empty message even when the transcript flag is set', () => {
  // Attachment-only sends pass text:'' — must not emit a bare tag.
  assert.equal(prependTranscribedTag('', true), '');
});
