class TermoService {
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

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    const chunks = [];

    return await new Promise((resolve, reject) => {
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.text(content);
      doc.end();
    });
  }
}

module.exports = TermoService;
