import React, { useState } from 'react';
import DateRangeModal from '../components/DateRangeModal.jsx';

/**
 * RelatoriosPage component - renders a button that triggers a long running
 * action and keeps the button disabled until the action completes. This
 * prevents double submissions and provides basic feedback to the user.
 */
export default function RelatoriosPage() {
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [period, setPeriod] = useState(null);

  const handleClick = async () => {
    // Avoid multiple simultaneous clicks
    if (loading) return;
    setLoading(true);

    try {
      // Simulate long running action. Replace with real logic.
      await new Promise(resolve => setTimeout(resolve, 1000));
    } finally {
      // Ensure the button is re-enabled even if the action throws
      setLoading(false);
    }
  };

  const handleSelectPeriod = range => {
    setPeriod(range);
  };

  return (
    <>
      <button onClick={() => setShowModal(true)}>Selecionar período</button>
      {period && (
        <div>
          {period.start} - {period.end}
        </div>
      )}

      {showModal && (
        <DateRangeModal
          onClose={() => setShowModal(false)}
          onSelect={handleSelectPeriod}
        />
      )}

      <button onClick={handleClick} disabled={loading}>
        {loading ? 'Gerando...' : 'Gerar Relatório'}
      </button>
    </>
  );
}
