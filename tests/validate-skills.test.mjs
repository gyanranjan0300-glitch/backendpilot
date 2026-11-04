import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { validateSkill } from '../scripts/validate-skills.mjs';

const fm = (/** @type {string} */ body) => `---\n${body}\n---\n# x\n`;

test('every skill in skills/ passes validation', () => {
  const dir = new URL('../skills/', import.meta.url);
  for (const name of readdirSync(dir)) {
    assert.deepEqual(validateSkill(readFileSync(new URL(`${name}/SKILL.md`, dir), 'utf8'), name), [], name);
  }
});

test('valid minimal skill', () => {
  assert.deepEqual(validateSkill(fm('name: my-skill\ndescription: Does a thing.'), 'my-skill'), []);
});

test('rejects spec violations', () => {
  const cases = [
    [fm('description: x'), 'name is required'],
    [fm('name: My-Skill\ndescription: x'), 'name must be lowercase'],
    [fm('name: a--b\ndescription: x'), 'name must be lowercase'],
    [fm('name: -a\ndescription: x'), 'name must be lowercase'],
    [fm('name: other\ndescription: x'), 'must match directory'],
    [fm('name: a'), 'description is required'],
    [fm(`name: a\ndescription: ${'x'.repeat(1025)}`), 'exceeds 1024'],
    [fm('name: a\ndescription: x\nversion: 1'), 'unknown field "version"'],
    [fm('name: a\ndescription: x\nmetadata:\n  v: 1'), 'metadata.v must be a string'],
    [fm('name: a\ndescription: x\ncompatibility: ""'), 'compatibility must be'],
    ['# no frontmatter', 'missing YAML frontmatter'],
  ];
  for (const [text, expected] of cases) {
    const dir = /name: (\S+)/.exec(text)?.[1] ?? 'a';
    const errors = validateSkill(text, dir === 'other' ? 'a' : dir);
    assert.ok(errors.some((e) => e.includes(expected)), `${expected} not in ${JSON.stringify(errors)}`);
  }
});
