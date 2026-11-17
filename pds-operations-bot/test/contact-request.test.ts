import assert from 'node:assert/strict';
import test from 'node:test';
import { formatChannelPost, formatPrefilledMessage, parseContactRequest } from '../src/contact-request.js';

const request = {
  name: 'JV MANES',
  role: 'IT Specialist',
  eventSite: 'Amparo Nature Park',
  date: 'October 17, 2026',
  concern: 'Please check my assignment.',
};

test('parses the prefilled contact form and multiline concern', () => {
  assert.deepEqual(parseContactRequest([
    'Name: JV MANES',
    'Role: IT Specialist',
    'Event Site: Amparo Nature Park',
    'Date: October 17, 2026',
    '',
    'Concern: Please check my assignment.',
    'I can provide more details if needed.',
  ].join('\n')), {
    ...request,
    concern: 'Please check my assignment.\nI can provide more details if needed.',
  });
});

test('requires a concern before posting', () => {
  assert.equal(parseContactRequest([
    'Name: JV MANES',
    'Role: IT Specialist',
    'Event Site: Amparo Nature Park',
    'Date: October 17, 2026',
    'Concern: ',
  ].join('\n')), null);
});

test('formats the notification deep-link draft with a blank concern field', () => {
  assert.equal(formatPrefilledMessage(request), [
    'Name: JV MANES',
    'Role: IT Specialist',
    'Event Site: Amparo Nature Park',
    'Date: October 17, 2026',
    '',
    'Concern: ',
  ].join('\n'));
});

test('formats the channel post without dropping the submitter identity', () => {
  assert.equal(formatChannelPost(request, 'JV Manes'), [
    'PDS Operations contact request',
    '',
    'Name: JV MANES',
    'Role: IT Specialist',
    'Event Site: Amparo Nature Park',
    'Date: October 17, 2026',
    '',
    'Concern: Please check my assignment.',
    'Submitted by: JV Manes',
  ].join('\n'));
});