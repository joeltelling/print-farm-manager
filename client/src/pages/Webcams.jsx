import { useState, useEffect, useCallback } from 'react';
import FleetStatusGrid from '../components/FleetStatusGrid';

const POLL_INTERVAL_MS = 15000;

// Shows every printer (not just camera-capable ones) in the same grouped grid
// as the Dashboard's fleet grid, so operators have one place to check status
// and hover for a camera preview without scrolling the Command Center.
export default function Webcams() {
  const [printers, setPrinters]   = useState(null);
  const [allModels, setAllModels] = useState([]);

  const fetchPrinters = useCallback(async () => {
    const res = await fetch('/api/printers');
    if (res.ok) setPrinters(await res.json());
  }, []);

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setAllModels).catch(() => {});
  }, []);

  useEffect(() => {
    fetchPrinters();
    const interval = setInterval(fetchPrinters, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchPrinters]);

  if (printers === null) {
    return <div style={{ color: '#64748b', fontSize: 14 }}>Loading...</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>
        Webcams
      </div>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>
        Hover a printer to preview its camera. Only printers with a snapshot configured show a
        preview here; open a printer's page to watch its live feed.
      </div>
      <FleetStatusGrid printers={printers} allModels={allModels} title="All Printers" />
    </div>
  );
}
