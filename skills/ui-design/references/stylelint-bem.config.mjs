// Apply only to project-owned global CSS; keep scoped/module/utility CSS in its own profile.
const word = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';

export default {
  defaultSeverity: 'error',
  reportInvalidScopeDisables: true,
  reportNeedlessDisables: true,
  rules: {
    'selector-class-pattern': [
      `^${word}(?:__${word})?(?:--${word})?$`,
      { message: 'Use block, block__element, block--modifier or block__element--modifier (lowercase kebab-case).' },
    ],
  },
};
