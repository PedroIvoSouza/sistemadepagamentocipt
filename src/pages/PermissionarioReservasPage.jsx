import React, { useState } from 'react';
import CalendarioReservas from '../components/CalendarioReservas.jsx';

const PermissionarioReservasPage = () => {
  const [events] = useState([
    {
      id: 1,
      title: 'Evento do permissionário',
      start: new Date(),
      end: new Date(new Date().getTime() + 2 * 60 * 60 * 1000)
    }
  ]);

  const handleReschedule = (event) => {
    alert(`Remarcar: ${event.title}`);
  };

  const handleCancel = (event) => {
    alert(`Cancelar: ${event.title}`);
  };

  return (
    <div style={{ height: '80vh', padding: '1rem' }}>
      <CalendarioReservas events={events} onReschedule={handleReschedule} onCancel={handleCancel} />
    </div>
  );
};

export default PermissionarioReservasPage;
