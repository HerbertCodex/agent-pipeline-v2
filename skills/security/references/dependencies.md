> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Dependencies

> **Note:** Examples use Node.js/npm syntax. Apply the same dependency security principles with your project's language and package manager (pip, cargo, bundler, Maven, etc.).

---

### Audit regularly
Run a vulnerability audit before every release and in CI, using `npm audit` or your package manager's equivalent (`pip audit`, `cargo audit`, `bundle audit`, etc.).

```bash
# Node.js
npm audit
npm audit fix        # auto-fix non-breaking updates
npm audit --audit-level=high  # fail CI only on high/critical

# Python
pip install pip-audit
pip-audit

# Ruby
gem install bundler-audit
bundle audit check --update
```

---

### Pin versions in production
Unpinned versions (`^`, `~`, `*`) can pull in a compromised package on the next install.
Use a lockfile and commit it.

```json
// ❌ package.json — unpinned, installs "latest compatible" on each npm install
{
  "dependencies": {
    "express": "^4.18.0",  // could install 4.19.x with a breaking security patch
    "lodash": "*"          // installs anything
  }
}

// ✅ package-lock.json or yarn.lock committed — exact versions locked
// Always commit your lockfile. Never add it to .gitignore.
```

---

### Never install packages blindly
Before installing a new package, check:

```
1. Downloads/week   → low downloads = less battle-tested
2. Last publish     → unmaintained packages don't get security patches
3. Maintainers      → single maintainer = higher supply chain risk
4. GitHub stars/issues → community signal
5. Dependencies     → packages with 200 transitive dependencies carry more risk
```

```bash
# Quick check before installing
npm info <package> | grep -E 'version|maintainers|published'

# Check known vulnerabilities
npx is-website-vulnerable https://yoursite.com
```

---

### Supply chain — typosquatting
Attackers publish packages with names similar to popular ones.

```bash
# ❌ Easy to mistype
npm install lodahs      # lodash
npm install expres      # express
npm install cros        # cors

# ✅ Always double-check the exact package name before installing
# Check npmjs.com to confirm the official package name and publisher
```

---

### Keep dependencies updated
Outdated dependencies are the most common attack vector.
Use a tool to automate update PRs.

```bash
# Check for outdated packages
npm outdated

# Interactive upgrade tool
npx npm-check-updates -i

# Automate with Dependabot (GitHub) or Renovate
# Add .github/dependabot.yml to your repo:
```

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
```

---

### Don't import what you don't need
Every imported package is an attack surface.

```ts
// ❌ Imports the entire lodash library (70KB+, hundreds of functions)
import _ from 'lodash'
const result = _.groupBy(items, 'category')

// ✅ Import only the function you need
import groupBy from 'lodash/groupBy'

// ✅ Better — use native alternatives when available (no dependency at all)
const result = Object.groupBy(items, item => item.category) // ES2024
```