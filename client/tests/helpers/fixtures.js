// Small, invented API payloads shaped like the real ones (see docs/api.md). Nothing here is
// real farm data: names, addresses and keys are made up.
const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

export const printers = [
  { id: 1, name: 'mk4-01', ip: '10.0.0.11', api_key: 'test-key', group_name: null, type: 'prusa', model: 'mk4s', status: 'PRINTING', is_held: 0, is_active: 1, created_at: NOW - 9e8, decommissioned_at: null, decommission_note: null, job_name: 'left_bracket.gcode', job_progress: 42, job_time_remaining: 3600, serial_number: null, loaded_material: 'PLA', loaded_color: 'Black', spoolman_spool_id: null, spoolman_report_usage: 0, last_parts_per_plate: 4, has_active_job: 1, has_uploading_job: 0, uploading_job_name: null, has_printing_job: 1 },
  { id: 2, name: 'mk4-02', ip: '10.0.0.12', api_key: 'test-key', group_name: 'Rack A', type: 'prusa', model: 'mk4s', status: 'FINISHED', is_held: 1, is_active: 1, created_at: NOW - 9e8, decommissioned_at: null, decommission_note: null, job_name: null, job_progress: null, job_time_remaining: null, serial_number: null, loaded_material: 'PLA', loaded_color: 'Black', spoolman_spool_id: null, spoolman_report_usage: 0, last_parts_per_plate: 4, has_active_job: 0, has_uploading_job: 0, uploading_job_name: null, has_printing_job: 0 },
  { id: 3, name: 'core-03', ip: '10.0.0.13', api_key: 'test-key', group_name: 'Rack A', type: 'prusa', model: 'mk4s', status: 'STOPPED', is_held: 1, is_active: 1, created_at: NOW - 9e8, decommissioned_at: null, decommission_note: null, job_name: null, job_progress: null, job_time_remaining: null, serial_number: null, loaded_material: 'PLA', loaded_color: 'Black', spoolman_spool_id: null, spoolman_report_usage: 0, last_parts_per_plate: 4, has_active_job: 0, has_uploading_job: 0, uploading_job_name: null, has_printing_job: 0 },
  { id: 4, name: 'mini-04', ip: '10.0.0.14', api_key: 'test-key', group_name: null, type: 'octoprint', model: 'mk4s', status: 'IDLE', is_held: 0, is_active: 1, created_at: NOW - 9e8, decommissioned_at: null, decommission_note: null, job_name: null, job_progress: null, job_time_remaining: null, serial_number: null, loaded_material: null, loaded_color: null, spoolman_spool_id: null, spoolman_report_usage: 0, last_parts_per_plate: null, has_active_job: 0, has_uploading_job: 0, uploading_job_name: null, has_printing_job: 0 },
];

export const models = [{ model_id: 'mk4s', label: 'MK4S', connector: 'prusa' }];
export const groups = [{ name: 'Rack A' }];

export const projects = [
  { id: 1, name: 'Bracket run', description: null, status: 'active', priority: 1, created_at: NOW - 8e8, updated_at: NOW - 1e8, required_material: 'PLA', required_color: 'Black', allowed_groups: null },
];

export const parts = [
  { id: 1, project_id: 1, name: 'Left bracket', target_qty: 100, completed_qty: 12, status: 'open', created_at: NOW - 8e8, updated_at: NOW - 1e8, sort_order: 1, print_time_seconds: 3600, material_grams: 45, active_qty: 1 },
];

export const jobs = [
  { id: 11, part_id: 1, printer_id: 1, gcode_id: 5, parts_per_plate: 4, status: 'printing', started_at: NOW - 3600e3, finished_at: null, created_at: NOW - 3600e3, spoolman_spool_id: null, spoolman_reported_at: null, part_name: 'Left bracket', project_id: 1, project_name: 'Bracket run', printer_name: 'mk4-01', printer_model: 'mk4s', printer_is_held: 0, printer_status: 'PRINTING' },
  { id: 10, part_id: 1, printer_id: 2, gcode_id: 5, parts_per_plate: 4, status: 'finished', started_at: NOW - 9000e3, finished_at: NOW - 5400e3, created_at: NOW - 9000e3, spoolman_spool_id: null, spoolman_reported_at: null, part_name: 'Left bracket', project_id: 1, project_name: 'Bracket run', printer_name: 'mk4-02', printer_model: 'mk4s', printer_is_held: 1, printer_status: 'FINISHED' },
  { id: 9, part_id: 1, printer_id: 3, gcode_id: 5, parts_per_plate: 4, status: 'failed', started_at: NOW - 20000e3, finished_at: NOW - 19000e3, created_at: NOW - 20000e3, spoolman_spool_id: null, spoolman_reported_at: null, part_name: 'Left bracket', project_id: 1, project_name: 'Bracket run', printer_name: 'core-03', printer_model: 'mk4s', printer_is_held: 1, printer_status: 'STOPPED' },
];

export const dashboard = {
  stats: { printing: 1, idle: 1, awaiting: 2, parts_today: 8 },
  printers,
  active_projects: [],
  recent_activity: [
    { id: 10, status: 'finished', parts_per_plate: 4, finished_at: NOW - 5400e3, part_name: 'Left bracket', printer_name: 'mk4-02' },
  ],
};

export const events = [
  { id: 2, printer_id: 1, event_type: 'job_finished', note: 'Job 10, part: Left bracket', created_at: NOW - 5400e3 },
  { id: 1, printer_id: 1, event_type: 'note', note: 'Cleaned the bed', created_at: NOW - 9000e3 },
];

export const jobHistory = {
  page: 1, total_pages: 1, total: 1,
  jobs: [{ id: 10, status: 'finished', parts_per_plate: 4, started_at: NOW - 9000e3, finished_at: NOW - 5400e3, duration_ms: 3600e3, part_name: 'Left bracket', project_name: 'Bracket run', gcode_filename: 'left_bracket.gcode' }],
};

export const jobStats = { total_jobs: 2, finished_jobs: 1, failed_jobs: 1, total_parts: 4, success_rate: 50, total_print_ms: 7200e3 };

// Every request the pages make on mount, for the whole app. Individual tests override entries.
export function baseRoutes(overrides = {}) {
  return {
    'GET /api/settings': { dispatch_batch_size: '10', spoolman_enabled: 'false', spoolman_base_url: '' },
    'GET /api/models': models,
    'GET /api/groups': groups,
    'GET /api/dashboard': dashboard,
    'GET /api/printers': printers,
    'GET /api/printers/decommissioned': [],
    'GET /api/printers/:id': (url) => printers.find((p) => `/api/printers/${p.id}` === url.pathname) ?? { status: 404, body: { error: 'Printer not found' } },
    'GET /api/printers/:id/events': events,
    'GET /api/printers/:id/jobs/stats': jobStats,
    'GET /api/printers/:id/jobs': jobHistory,
    'GET /api/projects': projects,
    'GET /api/parts': parts,
    'GET /api/jobs': jobs,
    'GET /api/notifications': [],
    'GET /api/filaments/types': [{ id: 1, name: 'PLA' }],
    'GET /api/filaments/colors': [{ id: 1, type_id: 1, name: 'Black', hex_color: '#111111', type_name: 'PLA' }],
    'GET /api/spoolman/status': { enabled: false, base_url: '', reachable: false, error: '' },
    'GET /api/gcodes': [],
    ...overrides,
  };
}
