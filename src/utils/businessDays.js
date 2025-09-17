// src/utils/businessDays.js
const FIXED_HOLIDAYS = new Set([
  '01-01', // Confraternização Universal
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalho
  '06-24', // São João (AL)
  '09-07', // Independência
  '09-16', // Emancipação Política de Alagoas
  '10-12', // Nossa Senhora Aparecida
  '11-02', // Finados
  '11-15', // Proclamação da República
  '12-25'  // Natal
]);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseDateInput(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const str = String(value).trim();
  if (!str) return null;

  let year;
  let month;
  let day;

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    [year, month, day] = str.split('-').map(Number);
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const parts = str.split('/');
    day = Number(parts[0]);
    month = Number(parts[1]);
    year = Number(parts[2]);
  } else if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
    const parts = str.split('-');
    day = Number(parts[0]);
    month = Number(parts[1]);
    year = Number(parts[2]);
  } else {
    const date = new Date(str);
    if (isNaN(date.getTime())) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  if (!year || !month || !day) return null;
  const coerced = new Date(year, month - 1, day);
  if (isNaN(coerced.getTime())) return null;
  return coerced;
}

function formatISODate(date) {
  const dt = parseDateInput(date);
  if (!dt) return null;
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function isHoliday(date, extraHolidays = []) {
  const dt = parseDateInput(date);
  if (!dt) return false;
  const mmdd = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  if (FIXED_HOLIDAYS.has(mmdd)) return true;

  return extraHolidays.some((raw) => {
    if (!raw) return false;
    const val = String(raw).trim();
    if (!val) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      return val === formatISODate(dt);
    }
    if (/^\d{2}[\/-]\d{2}$/.test(val)) {
      const token = val.replace('/', '-');
      return token === mmdd;
    }
    const parsed = parseDateInput(val);
    if (!parsed) return false;
    return formatISODate(parsed) === formatISODate(dt);
  });
}

function isBusinessDay(date, extraHolidays = []) {
  const dt = parseDateInput(date);
  if (!dt) return false;
  const day = dt.getDay();
  if (day === 0 || day === 6) return false;
  return !isHoliday(dt, extraHolidays);
}

function getLastBusinessDay(ano, mes, extraHolidays = []) {
  const year = Number(ano);
  const month = Number(mes);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error('Mês ou ano inválido para cálculo de último dia útil.');
  }
  let cursor = new Date(year, month, 0);
  while (!isBusinessDay(cursor, extraHolidays)) {
    cursor.setDate(cursor.getDate() - 1);
  }
  return cursor;
}

function getLastBusinessDayISO(ano, mes, extraHolidays = []) {
  const date = getLastBusinessDay(ano, mes, extraHolidays);
  return formatISODate(date);
}

module.exports = {
  parseDateInput,
  formatISODate,
  isHoliday,
  isBusinessDay,
  getLastBusinessDay,
  getLastBusinessDayISO
};
