import puppeteer from 'puppeteer';
import { ESPACOS_INFO } from '../config/espacos.js';

export default class TermoService {
  static _formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value).replace(/\u00A0/g, ' ');
  }

  static _formatDate(date) {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }).format(new Date(date));
  }

  static populateTemplate(template, data) {
    const replacements = {
      valor: data.valor !== undefined ? this._formatCurrency(data.valor) : undefined,
      data: data.data ? this._formatDate(data.data) : undefined,
      vigenciaInicio: data.vigencia && data.vigencia.inicio ? this._formatDate(data.vigencia.inicio) : undefined,
      vigenciaFim: data.vigencia && data.vigencia.fim ? this._formatDate(data.vigencia.fim) : undefined,
      saldoPagamento: data.saldoPagamento !== undefined ? this._formatCurrency(data.saldoPagamento) : undefined,
      clausulas: Array.isArray(data.clausulas) ? data.clausulas.join('; ') : undefined
    };

    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return replacements[key] !== undefined ? replacements[key] : '';
    });
  }

  static async generatePdf(template, data) {
    if (typeof data.saldoPagamento !== 'number' || data.saldoPagamento <= 0) {
      throw new Error('Saldo de pagamento insuficiente.');
    }
    if (!data.vigencia || !data.vigencia.inicio || !data.vigencia.fim) {
      throw new Error('Período de vigência inválido.');
    }
    if (!Array.isArray(data.clausulas) || data.clausulas.length === 0) {
      throw new Error('Cláusulas específicas não informadas.');
    }

    const content = this.populateTemplate(template, data);

    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(content, { waitUntil: 'networkidle0' });
      const buffer = await page.pdf({
        format: 'A4',
        margin: {
          top: '1cm',
          right: '1cm',
          bottom: '1cm',
          left: '1cm'
        }
      });
      return buffer;
    } finally {
      await browser.close();
    }
  }

  static getEspacoInfo(nome) {
    return ESPACOS_INFO[nome];
  }
}
