const fs = require('fs');
const path = require('path');

function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory() && !full.includes('node_modules') && !full.includes('.git') && !full.includes('dist')) {
      walk(full);
    } else if (f.isFile() && (f.name.endsWith('.tsx') || f.name.endsWith('.ts'))) {
      const c = fs.readFileSync(full, 'utf8');
      const m = c.match(/data-testid=["']nav-[^"']+["']/g);
      if (m) {
        console.log(full, m);
      }
    }
  }
}

walk('src');
