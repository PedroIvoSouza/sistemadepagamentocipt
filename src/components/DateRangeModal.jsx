import React, { useState } from 'react';

/**
 * Simple modal for selecting a date range. Uses native date inputs to keep
 * dependencies minimal. The selected range is returned via the `onSelect`
 * callback. Closing the modal without confirming does not change the parent
 * component's state.
 */
export default function DateRangeModal({ onClose, onSelect }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const handleConfirm = () => {
    onSelect({ start, end });
    onClose();
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.3)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <div style={{ background: '#fff', padding: '1rem', borderRadius: '4px', minWidth: '280px' }}>
        <h3>Selecionar período</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <label>
            Início:
            <input type="date" value={start} onChange={e => setStart(e.target.value)} />
          </label>
          <label>
            Fim:
            <input type="date" value={end} onChange={e => setEnd(e.target.value)} />
          </label>
        </div>
        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button onClick={onClose}>Cancelar</button>
          <button onClick={handleConfirm} disabled={!start || !end}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}

