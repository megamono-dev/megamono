import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'nx-laravel',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
