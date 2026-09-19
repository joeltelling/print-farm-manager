// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../src/App.jsx';
import { installDomCleanup, mockApi, t } from './helpers/env.jsx';
import { baseRoutes, jobs } from './helpers/fixtures.js';

installDomCleanup();

// The Jobs page keeps its three filters (status, project, printer) in the URL query string so a
// filtered view can be bookmarked or shared. This checks both directions: the URL seeds the
// filters and the requests, and changing a filter rewrites the URL (replacing, not pushing, so
// Back does not step through every filter tweak).
function jobsApi() {
  return mockApi(baseRoutes({
    'GET /api/jobs': (url) => {
      const status = url.searchParams.get('status');
      const printer = url.searchParams.get('printer_id');
      return jobs.filter((j) => (!status || j.status === status) && (!printer || String(j.printer_id) === printer));
    },
  }));
}

const jobRequests = (api) => api.calls.filter((c) => c.path === '/api/jobs').map((c) => c.search);

describe('Jobs page filters and the URL', () => {
  it('reads the filters from the query string and sends them to the API', async () => {
    window.history.pushState({}, '', '/jobs?status=failed&printer=3');
    const api = jobsApi();
    render(<App />);
    await screen.findByRole('heading', { name: t('jobs.title') });

    await waitFor(() => expect(jobRequests(api)).toContain('?status=failed&printer_id=3'));
    const [statusSelect, , printerSelect] = screen.getAllByRole('combobox');
    expect(statusSelect.value).toBe('failed');
    expect(printerSelect.value).toBe('3');
    // only the failed job on printer 3 comes back and is shown
    await screen.findByText(t('jobs.jobCount', { count: 1 }));
  });

  it('starts unfiltered, with a clean URL, when there is no query string', async () => {
    window.history.pushState({}, '', '/jobs');
    const api = jobsApi();
    render(<App />);
    await screen.findByRole('heading', { name: t('jobs.title') });

    await waitFor(() => expect(jobRequests(api)).toContain(''));
    expect(window.location.search).toBe('');
    await screen.findByText(t('jobs.jobCount', { count: 3 }));
  });

  it('writes a changed filter back to the URL and refetches', async () => {
    window.history.pushState({}, '', '/jobs');
    const api = jobsApi();
    render(<App />);
    await screen.findByRole('heading', { name: t('jobs.title') });
    await screen.findByText(t('jobs.jobCount', { count: 3 }));

    const [statusSelect] = screen.getAllByRole('combobox');
    fireEvent.change(statusSelect, { target: { value: 'finished' } });

    await waitFor(() => expect(window.location.search).toBe('?status=finished'));
    await waitFor(() => expect(jobRequests(api)).toContain('?status=finished'));
    await screen.findByText(t('jobs.jobCount', { count: 1 }));
  });

  it('keeps other filters when one changes, and drops a filter set back to "all"', async () => {
    window.history.pushState({}, '', '/jobs?status=failed&printer=3');
    jobsApi();
    render(<App />);
    await screen.findByRole('heading', { name: t('jobs.title') });

    const [statusSelect] = screen.getAllByRole('combobox');
    fireEvent.change(statusSelect, { target: { value: 'all' } });
    await waitFor(() => expect(window.location.search).toBe('?printer=3'));
  });

  it('replaces history entries instead of pushing them', async () => {
    window.history.pushState({}, '', '/jobs');
    jobsApi();
    render(<App />);
    await screen.findByRole('heading', { name: t('jobs.title') });
    const before = window.history.length;

    const [statusSelect] = screen.getAllByRole('combobox');
    fireEvent.change(statusSelect, { target: { value: 'finished' } });
    await waitFor(() => expect(window.location.search).toBe('?status=finished'));
    fireEvent.change(statusSelect, { target: { value: 'queued' } });
    await waitFor(() => expect(window.location.search).toBe('?status=queued'));

    expect(window.history.length).toBe(before);
  });
});
