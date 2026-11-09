/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/lib'],
  transform: { '^.+\\.ts$': ['@swc/jest'] },
};
