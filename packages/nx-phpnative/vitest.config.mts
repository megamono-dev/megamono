import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'nx-phpnative',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
