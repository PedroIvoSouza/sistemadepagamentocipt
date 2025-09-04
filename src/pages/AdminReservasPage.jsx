import React, { useState } from 'react';
import CalendarioReservas from '../components/CalendarioReservas.jsx';

const AdminReservasPage = () => {
  const [events] = useState([
    {
      id: 1,
      title: 'Reunião de planejamento',
      start: new Date(),
      end: new Date(new Date().getTime() + 60 * 60 * 1000)
    }
  ]);

  const handleReschedule = (event) => {
    // Implementar lógica real de remarcação
    alert(`Remarcar: ${event.title}`);
  };

  const handleCancel = (event) => {
    // Implementar lógica real de cancelamento
    alert(`Cancelar: ${event.title}`);
  };

  return (
    <div style={{ height: '80vh', padding: '1rem' }}>
      <CalendarioReservas events={events} onReschedule={handleReschedule} onCancel={handleCancel} />
    </div>
  );
};

export default AdminReservasPage;
