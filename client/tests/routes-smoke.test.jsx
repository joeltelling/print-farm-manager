// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../src/App.jsx';
import { installDomCleanup, mockApi, watchConsoleErrors, t } from './helpers/env.jsx';
import { baseRoutes } from './helpers/fixtures.js';

installDomCleanup();

// Each route mounts the whole app (BrowserRouter, sidebar, page) against a mocked API, waits
// for the page heading and for one piece of fixture data to render, then checks that the page
// asked for nothing the mock does not know about and logged no console errors. This is the
// test that catches a router, hook, or dependency change that builds fine but breaks a page
// at runtime. It deliberately asserts on nothing about layout or styling.
const heading = (key) => () => screen.findByRole('heading', { name: t(key) });

const PAGES = [
  { name: 'Dashboard', path: '/', ready: () => screen.findByText(t('dashboard.commandCenter')), data: 'mk4-01' },
  { name: 'Fleet', path: '/fleet', ready: heading('fleet.title'), data: 'mk4-02' },
  { name: 'Printers', path: '/printers', ready: heading('printers.title'), data: 'MK4S' },
  { name: 'Printer detail', path: '/printers/1', ready: () => screen.findByText(new RegExp(t('printerDetail.backToAllPrinters'))), data: 'Cleaned the bed' },
  { name: 'Projects', path: '/projects', ready: heading('projects.title'), data: 'Bracket run' },
  { name: 'Jobs', path: '/jobs', ready: heading('jobs.title'), data: 'Left bracket' },
  { name: 'Decommissioned', path: '/decommissioned', ready: heading('decommissioned.title'), data: null },
  { name: 'Settings', path: '/settings', ready: heading('settings.title'), data: 'MK4S' },
];

describe('routes render against a mocked API', () => {
  it.each(PAGES)('$name ($path)', async ({ path, ready, data }) => {
    window.history.pushState({}, '', path);
    const api = mockApi(baseRoutes());
    const errors = watchConsoleErrors();

    render(<App />);

    await ready();
    if (data) await waitFor(() => expect(screen.getAllByText(data).length).toBeGreaterThan(0));
    // let any remaining mount-time requests settle before checking what was asked for
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));

    expect(api.unmocked).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('client-side navigation', () => {
  it('moves between pages from the sidebar without a reload', async () => {
    window.history.pushState({}, '', '/');
    mockApi(baseRoutes());
    render(<App />);
    await screen.findByText(t('dashboard.commandCenter'));

    fireEvent.click(screen.getAllByRole('link', { name: t('nav.jobs') })[0]);
    await screen.findByRole('heading', { name: t('jobs.title') });
    expect(window.location.pathname).toBe('/jobs');

    fireEvent.click(screen.getAllByRole('link', { name: t('nav.settings') })[0]);
    await screen.findByRole('heading', { name: t('settings.title') });
    expect(window.location.pathname).toBe('/settings');
  });

  it('opens a printer detail page from the Printers directory', async () => {
    window.history.pushState({}, '', '/printers');
    mockApi(baseRoutes());
    render(<App />);
    await screen.findByRole('heading', { name: t('printers.title') });
    // groups start collapsed; expand them all, then click a printer row
    fireEvent.click(await screen.findByText(t('printers.expandAll')));
    fireEvent.click(await screen.findByText('mk4-01'));
    await screen.findByText(new RegExp(t('printerDetail.backToAllPrinters')));
    expect(window.location.pathname).toBe('/printers/1');
  });
});
