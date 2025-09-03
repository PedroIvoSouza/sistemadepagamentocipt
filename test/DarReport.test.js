import assert from 'assert';
import { fetchDar, renderDarReport, listEventReports, listPermissionarioReports } from '../src/reports/DarReport.js';

async function run() {
  let capturedUrl;
  const mockFetch = url => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 1, clienteEvento: { nome: 'Cliente X' } })
    });
  };

  const dar = await fetchDar(1, mockFetch);
  assert.ok(capturedUrl.includes('include=clienteEvento'));

  const report = renderDarReport(dar);
  assert.ok(report.includes('Cliente X'));

  // verify separated list functions add proper filters
  let eventUrl;
  await listEventReports({ periodo: '2024' }, url => {
    eventUrl = url;
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  assert.ok(eventUrl.includes('tipo=evento'));
  assert.ok(eventUrl.includes('include=clienteEvento'));

  let permUrl;
  await listPermissionarioReports({}, url => {
    permUrl = url;
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  assert.ok(permUrl.includes('tipo=permissionario'));

  console.log('DarReport tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

