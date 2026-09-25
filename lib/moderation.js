'use strict';

// A deliberately small, conservative filter for new submissions. It catches
// slurs, profanity and obvious hate or sexual terms, including common
// disguises (f4ck, $h1t, f.u.c.k, fuuuck). It cannot judge meaning, so
// anything that slips through is handled from the admin page.

// Matched as whole words only, so "class", "grape", "Scunthorpe" and
// "Fukuoka" are fine. Words with innocent uses (Dyke, Dick) are left to
// moderation.
const WORDS = [
  // slurs
  'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'fag', 'fags', 'kike', 'kikes',
  'spic', 'spics', 'chink', 'chinks', 'gook', 'gooks', 'wetback', 'wetbacks', 'tranny', 'trannies',
  'retard', 'retards', 'retarded', 'coon', 'coons', 'paki', 'pakis', 'beaner',
  'beaners', 'raghead', 'towelhead', 'shemale',
  // profanity
  'fuck', 'fucks', 'fck', 'fcking', 'fuk', 'fuking', 'fack', 'phuck', 'fcuk', 'fkn', 'fking', 'fucked', 'fucker', 'fuckers', 'fucking', 'shit', 'shits', 'shitty', 'bullshit',
  'cunt', 'cunts', 'cock', 'cocks', 'bitch', 'bitches', 'whore', 'whores', 'slut', 'sluts',
  'twat', 'wank', 'wanker', 'motherfucker', 'asshole', 'assholes', 'pussy',
  // sexual
  'porn', 'porno', 'cum', 'dildo', 'blowjob', 'handjob', 'anal', 'rape', 'raped', 'rapist', 'rapists',
  'pedo', 'pedophile', 'paedophile', 'incest', 'bestiality',
  // hate
  'hitler', 'nazi', 'nazis', 'kkk', 'heil',
  // abuse
  'kys',
];

// Multi-word phrases, matched on word boundaries.
const PHRASES = ['kill yourself', 'white power', 'sieg heil', 'gas the', 'final solution', 'go die'];

// Unmistakable even inside a longer word ("xXfuckXx").
const ANYWHERE = ['fuck', 'nigger', 'nigga', 'faggot', 'motherfuck', 'cunt', 'kike'];
// "cunt" inside words only trips on real words like "Scunthorpe", so allow those.
const ANYWHERE_OK = ['scunthorpe'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '+': 't' };

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0134578@$!+]/g, (c) => LEET[c]);
}

const collapse = (s) => s.replace(/(.)\1{2,}/g, '$1$1').replace(/(.)\1+/g, '$1'); // fuuuck -> fuck

const WORD_SET = new Set(WORDS);

function isOffensive(text) {
  const norm = normalize(String(text));
  const words = norm.split(/[^a-z]+/).filter(Boolean);
  // Whole words, as typed and with repeated letters collapsed.
  if (words.some((w) => WORD_SET.has(w) || WORD_SET.has(collapse(w)))) return true;
  // Single letters spelled out with separators: "f u c k", "f.u.c.k".
  const spelled = norm.match(/(?:^|[^a-z])((?:[a-z][^a-z]+){2,}[a-z])(?![a-z])/g) || [];
  for (const run of spelled) {
    const joined = run.replace(/[^a-z]/g, '');
    if (WORD_SET.has(joined) || WORD_SET.has(collapse(joined))) return true;
  }
  const spaced = ` ${words.join(' ')} `;
  if (PHRASES.some((p) => spaced.includes(` ${p} `))) return true;
  // Inside a word ("xXfuckXx"), never across words ("Mac Untitled").
  return words.some((w) => {
    for (const ok of ANYWHERE_OK) w = w.split(ok).join('');
    return ANYWHERE.some((bad) => w.includes(bad) || collapse(w).includes(bad));
  });
}

module.exports = { isOffensive };
