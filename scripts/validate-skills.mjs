#!/usr/bin/env node
// Validates every skills/*/SKILL.md against the Agent Skills specification (https://agentskills.io/specification).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ALLOWED = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * @param {string} text SKILL.md contents
 * @param {string} dirName parent directory name
 * @returns {string[]} errors
 */
export function validateSkill(text, dirName) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return ['missing YAML frontmatter delimited by ---'];
  let fm;
  try {
    fm = parse(m[1]);
  } catch (e) {
    return [`invalid YAML: ${/** @type {Error} */ (e).message}`];
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return ['frontmatter must be a mapping'];
  const errors = [];
  for (const k of Object.keys(fm)) if (!ALLOWED.has(k)) errors.push(`unknown field "${k}"`);
  const { name, description, compatibility, metadata, license } = fm;
  if (typeof name !== 'string' || !name) errors.push('name is required');
  else {
    if (name.length > 64) errors.push('name exceeds 64 characters');
    if (!NAME.test(name)) errors.push('name must be lowercase a-z, 0-9 and single hyphens, not starting or ending with a hyphen');
    if (name !== dirName) errors.push(`name "${name}" must match directory "${dirName}"`);
  }
  if (typeof description !== 'string' || !description.trim()) errors.push('description is required');
  else if (description.length > 1024) errors.push('description exceeds 1024 characters');
  if (license !== undefined && (typeof license !== 'string' || !license)) errors.push('license must be a non-empty string');
  if (compatibility !== undefined && (typeof compatibility !== 'string' || !compatibility || compatibility.length > 500)) errors.push('compatibility must be 1-500 characters');
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) errors.push('metadata must be a mapping');
    else for (const [k, v] of Object.entries(metadata)) if (typeof v !== 'string') errors.push(`metadata.${k} must be a string (quote it)`);
  }
  if (fm['allowed-tools'] !== undefined && typeof fm['allowed-tools'] !== 'string') errors.push('allowed-tools must be a space-separated string');
  if (text.split(/\r?\n/).length > 500) errors.push('SKILL.md exceeds the recommended 500 lines');
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? 'skills');
  let failed = 0;
  const skills = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const s of skills) {
    const file = join(dir, s.name, 'SKILL.md');
    const errors = existsSync(file) ? validateSkill(readFileSync(file, 'utf8'), s.name) : ['SKILL.md not found'];
    if (errors.length) {
      failed++;
      for (const e of errors) console.error(`✗ ${s.name}: ${e}`);
    } else console.log(`✓ ${s.name}`);
  }
  if (!skills.length) {
    console.error(`No skills found in ${dir}`);
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}
