// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, renderHook } from '@testing-library/react';
import { useToast } from '../src/useToast.jsx';
import { useConfirm } from '../src/useConfirm.jsx';
import { useFilamentLibrary } from '../src/useFilamentLibrary.js';
import { useFormattingLocale } from '../src/useFormattingLocale.js';
import { getFormattingLocale } from '../src/i18n.js';
import { installDomCleanup, mockApi, i18n, t } from './helpers/env.jsx';

installDomCleanup();

// ── useToast ─────────────────────────────────────────────────────────────────

function ToastHarness({ duration }) {
  const [showToast, toastEl] = useToast(duration);
  return (
    <>
      <button onClick={() => showToast('Saved')}>success</button>
      <button onClick={() => showToast('Failed', 'error')}>error</button>
      <button onClick={() => showToast('Careful', 'warning')}>warning</button>
      <button onClick={() => showToast('Quick', 'success', 300)}>custom</button>
      {toastEl}
    </>
  );
}

describe('useToast', () => {
  it('renders nothing until a toast is shown', () => {
    render(<ToastHarness />);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it.each([
    ['success', 'Saved', '✓'],
    ['error', 'Failed', '✕'],
    ['warning', 'Careful', '⚠'],
  ])('shows a %s toast with its icon', (variant, message, icon) => {
    render(<ToastHarness />);
    fireEvent.click(screen.getByText(variant));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByText(icon)).toBeTruthy();
  });

  it('dismisses success and error toasts after the default 2.5 seconds', () => {
    vi.useFakeTimers();
    render(<ToastHarness />);
    fireEvent.click(screen.getByText('error'));
    act(() => { vi.advanceTimersByTime(2499); });
    expect(screen.queryByText('Failed')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('keeps warnings up longer (4.5 seconds) so they can be read', () => {
    vi.useFakeTimers();
    render(<ToastHarness />);
    fireEvent.click(screen.getByText('warning'));
    act(() => { vi.advanceTimersByTime(4499); });
    expect(screen.queryByText('Careful')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Careful')).toBeNull();
  });

  it('honors a custom duration for one toast and a custom default for the hook', () => {
    vi.useFakeTimers();
    render(<ToastHarness duration={1000} />);
    fireEvent.click(screen.getByText('custom'));
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText('Quick')).toBeNull();

    fireEvent.click(screen.getByText('success'));
    act(() => { vi.advanceTimersByTime(999); });
    expect(screen.queryByText('Saved')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('shows the newest toast when a second one replaces the first', () => {
    vi.useFakeTimers();
    render(<ToastHarness />);
    fireEvent.click(screen.getByText('success'));
    act(() => { vi.advanceTimersByTime(10); });
    fireEvent.click(screen.getByText('error'));
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.queryByText('Failed')).not.toBeNull();
  });
});

// ── useConfirm ───────────────────────────────────────────────────────────────

function ConfirmHarness({ options, onResult }) {
  const [confirm, confirmModal] = useConfirm();
  return (
    <>
      <button onClick={async () => onResult(await confirm(options))}>open</button>
      {confirmModal}
    </>
  );
}

async function openConfirm(options) {
  const onResult = vi.fn();
  render(<ConfirmHarness options={options} onResult={onResult} />);
  fireEvent.click(screen.getByText('open'));
  await screen.findByRole('alertdialog');
  return onResult;
}

describe('useConfirm', () => {
  it('shows nothing until confirm() is called, then a titled dialog with the message', async () => {
    render(<ConfirmHarness options={{ title: 'Delete part?', message: 'This cannot be undone.' }} onResult={() => {}} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByText('open'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete part?' });
    expect(dialog.textContent).toContain('This cannot be undone.');
  });

  it('resolves true when confirmed, and closes', async () => {
    const onResult = await openConfirm({ title: 'Go?', confirmLabel: 'Do it' });
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('falls back to the translated Confirm and Cancel labels', async () => {
    await openConfirm({ title: 'Go?' });
    expect(screen.getByRole('button', { name: t('common.confirm') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('common.cancel') })).toBeTruthy();
  });

  it('resolves null when cancelled', async () => {
    const onResult = await openConfirm({ title: 'Go?' });
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
  });

  it('resolves null on Escape', async () => {
    const onResult = await openConfirm({ title: 'Go?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves null when the backdrop is clicked, but not when the dialog itself is', async () => {
    const onResult = await openConfirm({ title: 'Go?' });
    fireEvent.click(screen.getByRole('alertdialog'));
    expect(onResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('alertdialog').parentElement);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
  });

  it('resolves with the chosen value when given several actions', async () => {
    const onResult = await openConfirm({
      title: 'Print result?',
      actions: [
        { value: 'good', label: 'All good', variant: 'success' },
        { value: 'bad', label: 'Bad print', variant: 'danger' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bad print' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('bad'));
  });

  it('collects trimmed text from a prompt and returns it with the choice', async () => {
    const onResult = await openConfirm({ title: 'Decommission', prompt: 'Why?', confirmLabel: 'Decommission' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  bad hotend  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decommission' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ value: true, text: 'bad hotend' }));
  });

  it('cannot be confirmed until a required prompt has text', async () => {
    const onResult = await openConfirm({ title: 'Reason', prompt: 'Why?', promptRequired: true, confirmLabel: 'Save' });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onResult).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true); // whitespace only

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'because' } });
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false);
  });

  it('cancelling a prompt resolves null, not an empty object', async () => {
    const onResult = await openConfirm({ title: 'Reason', prompt: 'Why?' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typed something' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
  });

  it('starts each prompt empty, even after a previous one was typed into', async () => {
    const onResult = vi.fn();
    render(<ConfirmHarness options={{ title: 'Reason', prompt: 'Why?' }} onResult={onResult} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.confirm') }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());

    fireEvent.click(screen.getByText('open'));
    expect((await screen.findByRole('textbox')).value).toBe('');
  });
});

// ── useFilamentLibrary ───────────────────────────────────────────────────────

describe('useFilamentLibrary', () => {
  const localLibrary = {
    'GET /api/settings': { spoolman_enabled: 'false' },
    'GET /api/filaments/types': [{ id: 1, name: 'PLA' }, { id: 2, name: 'PETG' }],
    'GET /api/filaments/colors': [{ id: 1, type_id: 1, name: 'Black', hex_color: '#111111', type_name: 'PLA' }],
  };

  it('loads the local Filament Library when Spoolman is off', async () => {
    mockApi(localLibrary);
    const { result } = renderHook(() => useFilamentLibrary());
    await waitFor(() => expect(result.current.filamentTypes).toHaveLength(2));
    expect(result.current.librarySource).toBe('local');
    expect(result.current.filamentColors.map((c) => c.name)).toEqual(['Black']);
  });

  it('sources types and colors from Spoolman when it is enabled, in the same shape', async () => {
    mockApi({
      'GET /api/settings': { spoolman_enabled: 'true' },
      'GET /api/spoolman/filaments': [
        { material: 'PETG', name: 'Prusament PETG Signal Red', color_hex: 'cc0000' },
        { material: 'PLA', name: 'Black', color_hex: '1a1a1a' },
        { material: 'PLA', name: 'Black', color_hex: '1a1a1a' }, // duplicate spool of the same filament
        { material: 'PLA', name: 'Rainbow' },                    // multi-color: no single hex, skipped from colors
        { name: 'No material' },                                 // no material: skipped entirely
      ],
    });
    const { result } = renderHook(() => useFilamentLibrary());
    await waitFor(() => expect(result.current.librarySource).toBe('spoolman'));
    await waitFor(() => expect(result.current.filamentTypes.length).toBeGreaterThan(0));

    expect(result.current.filamentTypes).toEqual([{ id: 'PETG', name: 'PETG' }, { id: 'PLA', name: 'PLA' }]);
    expect(result.current.filamentColors).toEqual([
      { id: 'PLA|Black', name: 'Black', hex_color: '#1A1A1A', type_name: 'PLA' },
      { id: 'PETG|Prusament PETG Signal Red', name: 'Prusament PETG Signal Red', hex_color: '#CC0000', type_name: 'PETG' },
    ].sort((a, b) => a.name.localeCompare(b.name)));
  });

  it('treats a failed Spoolman request as an empty list, not an error', async () => {
    mockApi({
      'GET /api/settings': { spoolman_enabled: 'true' },
      'GET /api/spoolman/filaments': { status: 502, body: { error: 'unreachable' } },
    });
    const { result } = renderHook(() => useFilamentLibrary());
    await waitFor(() => expect(result.current.librarySource).toBe('spoolman'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.filamentTypes).toEqual([]);
    expect(result.current.filamentColors).toEqual([]);
  });

  it('swallows a network failure and stays empty', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const { result } = renderHook(() => useFilamentLibrary());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.filamentTypes).toEqual([]);
    expect(result.current.librarySource).toBe('local');
  });

  it('refetches on demand and picks up changes', async () => {
    const routes = { ...localLibrary };
    mockApi(routes);
    const { result } = renderHook(() => useFilamentLibrary());
    await waitFor(() => expect(result.current.filamentTypes).toHaveLength(2));

    routes['GET /api/filaments/types'] = [{ id: 1, name: 'PLA' }];
    mockApi(routes);
    await act(async () => { result.current.refetchFilamentLibrary(); });
    await waitFor(() => expect(result.current.filamentTypes).toHaveLength(1));
  });
});

// ── formatting locale ────────────────────────────────────────────────────────

describe('formatting locale', () => {
  it('keeps the browser regional variant when it matches the active language (en + en-GB = en-GB)', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'en-GB']);
    expect(getFormattingLocale({ resolvedLanguage: 'en' })).toBe('en-GB');
  });

  it('uses the chosen language as-is when no browser language matches it', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en-GB']);
    expect(getFormattingLocale({ resolvedLanguage: 'pl' })).toBe('pl');
  });

  it('falls back through language to en', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue([]);
    expect(getFormattingLocale({ language: 'de' })).toBe('de');
    expect(getFormattingLocale({})).toBe('en');
  });

  it('useFormattingLocale returns the locale for the active i18n instance', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en-GB']);
    const { result } = renderHook(() => useFormattingLocale());
    expect(result.current).toBe(getFormattingLocale(i18n));
    expect(result.current).toBe('en-GB');
  });
});
