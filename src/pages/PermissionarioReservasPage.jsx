import React, { useState } from 'react';
import CalendarioReservas from '../components/CalendarioReservas.jsx';
import ReservaService from '../services/ReservaService.js';

const modalStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0,0,0,0.3)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const boxStyle = {
  background: '#fff',
  padding: '1rem',
  borderRadius: '4px',
  minWidth: '300px'
};

const PermissionarioReservasPage = () => {
  const [events, setEvents] = useState([
    {
      id: 1,
      title: 'Evento do permissionário',
      start: new Date(),
      end: new Date(new Date().getTime() + 2 * 60 * 60 * 1000)
    }
  ]);

  const [selected, setSelected] = useState(null);
  const [showReschedule, setShowReschedule] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');

  const handleReschedule = (event) => {
    setSelected(event);
    setNewStart(event.start.toISOString().slice(0,16));
    setNewEnd(event.end.toISOString().slice(0,16));
    setShowReschedule(true);
  };

  const handleCancel = (event) => {
    setSelected(event);
    setShowCancel(true);
  };

  const confirmReschedule = async () => {
    try {
      await ReservaService.updateReserva(selected.id, { start: newStart, end: newEnd });
      setEvents(prev => prev.map(ev => ev.id === selected.id ? { ...ev, start: new Date(newStart), end: new Date(newEnd) } : ev));
    } catch (err) {
      console.error(err);
    }
    setShowReschedule(false);
    setSelected(null);
  };

  const confirmCancel = async () => {
    try {
      await ReservaService.deleteReserva(selected.id);
      setEvents(prev => prev.filter(ev => ev.id !== selected.id));
    } catch (err) {
      console.error(err);
    }
    setShowCancel(false);
    setSelected(null);
  };

  return (
    <div style={{ height: '80vh', padding: '1rem' }}>
      <CalendarioReservas events={events} onReschedule={handleReschedule} onCancel={handleCancel} />

      {showReschedule && (
        <div style={modalStyle}>
          <div style={boxStyle}>
            <h3>Remarcar Reserva</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label>
                Início:
                <input type="datetime-local" value={newStart} onChange={e => setNewStart(e.target.value)} />
              </label>
              <label>
                Fim:
                <input type="datetime-local" value={newEnd} onChange={e => setNewEnd(e.target.value)} />
              </label>
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button onClick={() => { setShowReschedule(false); setSelected(null); }}>Cancelar</button>
              <button onClick={confirmReschedule} disabled={!newStart || !newEnd}>Salvar</button>
            </div>
          </div>
        </div>
      )}

      {showCancel && (
        <div style={modalStyle}>
          <div style={boxStyle}>
            <h3>Cancelar Reserva</h3>
            <p>Tem certeza que deseja cancelar "{selected?.title}"?</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button onClick={() => { setShowCancel(false); setSelected(null); }}>Não</button>
              <button onClick={confirmCancel}>Sim</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PermissionarioReservasPage;
