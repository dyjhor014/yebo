/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/lib', '<rootDir>/components'],
  transform: { '^.+\\.ts$': ['@swc/jest'] },
};
