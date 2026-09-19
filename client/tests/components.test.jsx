// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EmptyState from '../src/components/EmptyState.jsx';
import PollTimer from '../src/components/PollTimer.jsx';
import { installDomCleanup, t } from './helpers/env.jsx';

installDomCleanup();

describe('EmptyState', () => {
  it('shows the title and hint', () => {
    render(<MemoryRouter><EmptyState title="Nothing here" hint="Add something first" /></MemoryRouter>);
    expect(screen.getByText('Nothing here')).toBeTruthy();
    expect(screen.getByText('Add something first')).toBeTruthy();
  });

  it('renders the action as a link to the target route', () => {
    render(<MemoryRouter><EmptyState title="Empty" actionLabel="Go to Settings" actionTo="/settings" /></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Go to Settings' });
    expect(link.getAttribute('href')).toBe('/settings');
  });

  it('renders no link unless both a label and a target are given', () => {
    render(<MemoryRouter><EmptyState title="A" actionLabel="Only a label" /></MemoryRouter>);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders children between the hint and the action', () => {
    render(<MemoryRouter><EmptyState title="A"><span>extra content</span></EmptyState></MemoryRouter>);
    expect(screen.getByText('extra content')).toBeTruthy();
  });
});

describe('PollTimer', () => {
  const ring = (container) => container.querySelector('svg');
  const progressCircle = (container) => container.querySelectorAll('circle')[1];

  it('reports seconds since the last poll and fills the ring as time passes', () => {
    vi.useFakeTimers();
    const { container } = render(<PollTimer lastPolled={Date.now()} intervalMs={15000} size={20} />);
    expect(ring(container).getAttribute('title')).toBe(t('common.lastRefresh', { seconds: 0 }));

    const circumference = Number(progressCircle(container).getAttribute('stroke-dasharray'));
    const emptyOffset = Number(progressCircle(container).getAttribute('stroke-dashoffset'));
    expect(emptyOffset).toBeCloseTo(circumference, 3); // nothing filled yet

    act(() => { vi.advanceTimersByTime(7500); });
    expect(ring(container).getAttribute('title')).toBe(t('common.lastRefresh', { seconds: 8 }));
    expect(Number(progressCircle(container).getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference / 2, 3);
  });

  it('never fills past 100 percent', () => {
    vi.useFakeTimers();
    const { container } = render(<PollTimer lastPolled={Date.now()} intervalMs={15000} />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(Number(progressCircle(container).getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 3);
  });

  it('starts over when a new poll lands', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<PollTimer lastPolled={Date.now()} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(ring(container).getAttribute('title')).toBe(t('common.lastRefresh', { seconds: 10 }));

    rerender(<PollTimer lastPolled={Date.now()} />);
    expect(ring(container).getAttribute('title')).toBe(t('common.lastRefresh', { seconds: 0 }));
  });

  it('stays at zero and does not tick when nothing has been polled yet', () => {
    vi.useFakeTimers();
    const { container } = render(<PollTimer lastPolled={null} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(ring(container).getAttribute('title')).toBe(t('common.lastRefresh', { seconds: 0 }));
  });

  it('stops its timer when unmounted', () => {
    vi.useFakeTimers();
    const { unmount } = render(<PollTimer lastPolled={Date.now()} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
