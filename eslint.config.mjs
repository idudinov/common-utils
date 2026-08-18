import zajno from '@zajno/eslint-config';

export default [
    ...zajno,
    {
        ignores: [
            '**/node_modules/**/*',
            '**/dist/**/*',
            '.eslintrc.js',
            '**/vitest.config.mts',
        ],
    },
    {
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['@zajno/*/**/*.js', '@zajno/*/*.js'],
                    message: '@zajno/* subpath imports must be extensionless (exports maps have no .js suffix).',
                }],
            }],
        },
    },
];
