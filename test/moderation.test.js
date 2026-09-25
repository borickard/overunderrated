'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isOffensive } = require('../lib/moderation');

test('blocks offensive submissions, including disguised ones', () => {
  for (const s of ['fuck', 'F4CK this', 'f.u.c.k', 'f u c k', 'Fuuuuck', 'xXfuckXx', '$h1t', 'Bullshit',
    'n1gger', 'Kill yourself', 'White power', 'Hitler', 'Nazis', 'Porn', 'retarded people', 'motherfuckers']) {
    assert.equal(isOffensive(s), true, s);
  }
});

test('allows innocent words that contain or resemble bad ones', () => {
  for (const s of ['Class', 'Grape juice', 'Scunthorpe', 'Dick Van Dyke', 'Philip K. Dick', 'Cucumber',
    'Mac Untitled', 'Gas theater', 'Shiitake mushrooms', 'Assassins Creed', 'Cocktails', 'Peacock',
    'Alan Cumming', 'Analysis', 'Therapist', 'Spicy food', 'Raccoons', 'Pakistan', 'Blink-182', 'Area 51',
    'Hancock', 'Cockpit', 'Scrapbooking', 'Nazareth', 'Bass guitar', 'Fukuoka', 'Pineapple on pizza']) {
    assert.equal(isOffensive(s), false, s);
  }
});
