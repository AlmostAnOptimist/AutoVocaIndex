// eslint.gate.config.js
// The deploy gate. Netlify runs `npm run lint:gate` before the
// build; any error here stops the deploy and the previous version stays live.
//
// Only crash-class rules are on: mistakes that throw the moment the code
// runs. Style findings stay in the everyday config (eslint.config.js,
// `npm run lint`) and never block a deploy.
//
// What this catches that the everyday config can't: a component used in JSX
// without being imported (local/jsx-no-undef). Core `no-undef` doesn't look
// at JSX names, so a missing import builds fine and crashes the page the
// moment it opens.
//
// What no lint can catch: a function called with the wrong arguments. Tests
// cover that kind (`npm test`).

import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// <Thing /> or <Thing.Part /> where `Thing` is neither declared in the file
// nor a known global. Lower-case names are HTML/SVG tags and are skipped.
const jsxNoUndef = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { undef: "'{{name}}' is used in JSX but is not defined or imported." },
  },
  create(context) {
    const sourceCode = context.sourceCode
    return {
      JSXOpeningElement(node) {
        let id = node.name
        if (id.type === 'JSXNamespacedName') return
        const isMember = id.type === 'JSXMemberExpression'
        while (id.type === 'JSXMemberExpression') id = id.object
        if (id.type !== 'JSXIdentifier') return
        const name = id.name
        if (name === 'this') return
        if (!isMember && /^[a-z]/.test(name)) return
        for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
          if (scope.set.has(name)) return
        }
        context.report({ node: id, messageId: 'undef', data: { name } })
      },
    }
  },
}

const crashRules = {
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-import-assign': 'error',
  'no-func-assign': 'error',
  'no-class-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-obj-calls': 'error',
  'no-this-before-super': 'error',
  'constructor-super': 'error',
  'getter-return': 'error',
  'no-setter-return': 'error',
  'no-unsafe-negation': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
}

export default [
  // src/vendor holds other people's code kept in the repo as it came
  // (the Korean analyser, src/vendor/garu-ko); it isn't ours to lint.
  { ignores: ['dist/**', 'src/vendor/**'] },
  // Existing `eslint-disable` comments name rules from these plugins, so the
  // plugins must be known here even though only one of their rules is on.
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      local: { rules: { 'jsx-no-undef': jsxNoUndef } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...crashRules,
      'local/jsx-no-undef': 'error',
      // A hook called conditionally or in a loop breaks React at runtime.
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  // Netlify functions run in Node. `Netlify` is the runtime's own global.
  {
    files: ['netlify/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, Netlify: 'readonly' },
    },
    rules: crashRules,
  },
  {
    files: ['netlify/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: crashRules,
  },
]
