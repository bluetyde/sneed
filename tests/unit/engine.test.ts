import { describe, expect, it } from 'vitest';
import { regexEscape, toWslPath } from '../../src/core/engine.js';

describe('regexEscape (pkill -f takes an extended regular expression)', () => {
  it('escapes every regex metacharacter with a backslash', () => {
    expect(regexEscape('a.b')).toBe('a\\.b');
    expect(regexEscape('a+b*c?')).toBe('a\\+b\\*c\\?');
    expect(regexEscape('(x)[y]{z}')).toBe('\\(x\\)\\[y\\]\\{z\\}');
    expect(regexEscape('a|b^c$d')).toBe('a\\|b\\^c\\$d');
    expect(regexEscape('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves plain path characters alone', () => {
    expect(regexEscape('/root/sneed-runtime/scram/0-r1_x')).toBe('/root/sneed-runtime/scram/0-r1_x');
  });

  it('the escaped text matches the original literally and nothing that merely resembles it', () => {
    for (const tag of ['/tmp/a (1) [2]+x.y-z', '/root/sneed-runtime/scram/0.16.2-r1-20261005T120000Z-abcdef', 'a|b', 'c^d$e', '{1,2}', 'x*y?']) {
      const re = new RegExp(regexEscape(tag));
      expect(re.test(tag), tag).toBe(true);
      expect(re.test(`prefix-${tag}-suffix`), tag).toBe(true); // pkill -f matches inside a command line
    }
    // an unescaped dot would match any character; the escaped one must not
    expect(new RegExp(regexEscape('0.16.2')).test('0x16y2')).toBe(false);
    // an unescaped group would match the text without its parentheses; the escaped one must not
    expect(new RegExp(regexEscape('mine (123) tag')).test('mine 123 tag')).toBe(false);
  });
});

describe('toWslPath', () => {
  it('converts drive paths, keeps spaces and rejects anything else', () => {
    expect(toWslPath('C:\\Users\\alice\\Course Files\\runs\\a')).toBe('/mnt/c/Users/alice/Course Files/runs/a');
    expect(toWslPath('D:/OpenMC/x')).toBe('/mnt/d/OpenMC/x');
    expect(() => toWslPath('\\\\wsl$\\Ubuntu\\root')).toThrow();
  });
});
