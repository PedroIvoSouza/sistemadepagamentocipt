const DAR_API = 'https://api.example.com/dar';

/**
 * Fetch a DAR including clienteEvento data.
 * @param {number|string} id - DAR identifier.
 * @param {Function} fetchImpl - optional fetch implementation for testing.
 * @returns {Promise<object>}
 */
export async function fetchDar(id, fetchImpl = fetch) {
  const url = `${DAR_API}/${id}?include=clienteEvento`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch DAR ${id}`);
  }
  return response.json();
}

/**
 * Render a simple textual report including clienteEvento.nome.
 * @param {object} dar - DAR data returned from fetchDar.
 * @returns {string} - formatted report string.
 */
export function renderDarReport(dar) {
  const nome = dar?.clienteEvento?.nome ?? '';
  return `DAR ${dar.id}\nCliente do Evento: ${nome}`;
}

/**
 * Fetch DAR reports filtered for events.
 * This demonstrates separation of reports between eventos e permissionários.
 * @param {object} filters - optional filters.
 * @param {Function} fetchImpl - optional fetch implementation for testing.
 */
export async function listEventReports(filters = {}, fetchImpl = fetch) {
  const params = new URLSearchParams({ ...filters, tipo: 'evento', include: 'clienteEvento' });
  const response = await fetchImpl(`${DAR_API}?${params.toString()}`);
  return response.json();
}

/**
 * Fetch DAR reports filtered for permissionários.
 * @param {object} filters - optional filters.
 * @param {Function} fetchImpl - optional fetch implementation for testing.
 */
export async function listPermissionarioReports(filters = {}, fetchImpl = fetch) {
  const params = new URLSearchParams({ ...filters, tipo: 'permissionario', include: 'clienteEvento' });
  const response = await fetchImpl(`${DAR_API}?${params.toString()}`);
  return response.json();
}

