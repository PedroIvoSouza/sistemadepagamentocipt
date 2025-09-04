import React from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import ptBR from 'date-fns/locale/pt-BR/index.js';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './CalendarioReservas.css';

const locales = {
  'pt-BR': ptBR
};

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales
});

/**
 * CalendarioReservas encapsula react-big-calendar com tema inspirado no Google Calendar.
 * Aceita eventos no formato { id, title, start, end } e callbacks para ações rápidas.
 */
const CalendarioReservas = ({ events = [], onReschedule, onCancel }) => {
  const EventComponent = ({ event }) => (
    <span className="rbc-event-content">
      {event.title}
      <span className="event-actions">
        <button
          className="reschedule"
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
            onReschedule && onReschedule(event);
          }}
        >
          🔁
        </button>
        <button
          className="cancel"
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
            onCancel && onCancel(event);
          }}
        >
          ✖️
        </button>
      </span>
    </span>
  );

  return (
    <div className="calendario-reservas">
      <Calendar
        localizer={localizer}
        events={events}
        components={{ event: EventComponent }}
        views={["day", "week", "month"]}
        defaultView="week"
        style={{ height: "100%" }}
        popup
      />
    </div>
  );
};

export default CalendarioReservas;
