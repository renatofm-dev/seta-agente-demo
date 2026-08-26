import { describe, expect, it } from 'vitest';
import { cn } from '../lib/utils';

describe('console/lib/utils', () => {
  it('cn combina classes condicionais', () => {
    expect(cn('a', false && 'b', 'c')).toBe('a c');
  });

  it('cn resolve conflitos de utilitários tailwind (última vence)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });
});
