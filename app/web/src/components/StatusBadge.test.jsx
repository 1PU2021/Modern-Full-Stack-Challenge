import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders backend status values accessibly', () => {
    render(<StatusBadge status="rate_limited" />);
    expect(screen.getByText('rate_limited')).toBeInTheDocument();
  });
});
