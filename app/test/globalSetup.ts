import { execFileSync } from 'node:child_process';

// Build dist/task-card.html once for every test file that inspects it.
export default function setup() {
  execFileSync('node', ['scripts/build.mjs'], { stdio: 'pipe' });
}
