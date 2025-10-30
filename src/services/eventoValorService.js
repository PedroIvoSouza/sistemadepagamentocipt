// Em: src/services/eventoValorService.js

/**
 * Contém a lógica de negócios para calcular os valores dos eventos
 * com base na tabela de descontos progressivos e descontos por tipo de cliente.
 */

const buildTabela = (valores) => {
    const arr = Array.isArray(valores) ? [...valores] : [];
    if (arr.length === 4) arr.push(arr[3]);
    return arr.map((valor) => Number.parseFloat(Number(valor || 0).toFixed(2)));
};

const DEFAULT_TABELAS = {
    AUDITORIO: buildTabela([2495.00, 1996.00, 1596.80, 1277.44]),
};

DEFAULT_TABELAS.ANFITEATRO = buildTabela(
    DEFAULT_TABELAS.AUDITORIO.map((valorBase, index) => {
        const base = index >= 3 ? DEFAULT_TABELAS.AUDITORIO[3] : valorBase;
        return base * 0.6;
    })
);

function parseTabelaOverride(nome, fallback) {
    const raw = process.env[`EVENTO_TABELA_PRECOS_${nome}`];
    if (!raw) return fallback;
    const valores = String(raw)
        .split(',')
        .map((parte) => Number.parseFloat(parte.trim().replace(',', '.')))
        .filter((valor) => Number.isFinite(valor));
    if (!valores.length) return fallback;
    return buildTabela(valores);
}

const TABELAS_PRECOS = Object.keys(DEFAULT_TABELAS).reduce((acc, chave) => {
    acc[chave] = parseTabelaOverride(chave, DEFAULT_TABELAS[chave]);
    return acc;
}, {});

function normalizarEspacoNome(espaco) {
    if (!espaco) return '';
    return String(espaco)
        .normalize('NFD')
        .replace(/[^\w\s]/g, '')
        .trim()
        .toUpperCase();
}

function identificarTabelaPorEspacos(espacos = []) {
    const lista = Array.isArray(espacos) ? espacos : [espacos];
    const normalizados = lista.map(normalizarEspacoNome).filter(Boolean);
    if (!normalizados.length) return 'AUDITORIO';

    if (normalizados.some((nome) => nome.includes('AUDITORIO'))) {
        return 'AUDITORIO';
    }

    if (normalizados.some((nome) => nome.includes('ANFITEATRO'))) {
        return 'ANFITEATRO';
    }

    return 'AUDITORIO';
}

/**
 * Calcula o valor bruto total de um evento com base no número de diárias.
 * @param {number} totalDiarias - O número total de dias do evento.
 * @param {string[]|string} espacos - Espaços associados ao evento.
 * @returns {number} O valor bruto total.
 */
function calcularValorBruto(totalDiarias, espacos) {
    if (totalDiarias <= 0) return 0;

    const chaveTabela = identificarTabelaPorEspacos(espacos);
    const precosPorDia = TABELAS_PRECOS[chaveTabela] || TABELAS_PRECOS.AUDITORIO;

    let valorTotal = 0;
    if (totalDiarias >= 1) valorTotal += precosPorDia[0];
    if (totalDiarias >= 2) valorTotal += precosPorDia[1];
    if (totalDiarias >= 3) valorTotal += precosPorDia[2];
    if (totalDiarias >= 4) {
        const diariasRestantes = totalDiarias - 3;
        valorTotal += diariasRestantes * precosPorDia[3];
    }

    return parseFloat(valorTotal.toFixed(2));
}

/**
 * Calcula o valor final de um evento aplicando os descontos.
 * @param {number} valorBruto - O valor bruto do evento.
 * @param {string} tipoCliente - 'Geral', 'Governo' ou 'Permissionario'.
 * @param {number} descontoManualPercent - Percentual de desconto manual (ex: 10 para 10%).
 * @returns {number} O valor final a ser pago.
 */
function calcularValorFinal(valorBruto, tipoCliente, descontoManualPercent = 0) {
    let valorComDesconto = valorBruto;

    if (tipoCliente === 'Governo') {
        valorComDesconto *= 0.80;
    } else if (tipoCliente === 'Permissionario') {
        valorComDesconto *= 0.40;
    }

    if (descontoManualPercent > 0) {
        valorComDesconto *= (1 - (descontoManualPercent / 100));
    }

    return parseFloat(valorComDesconto.toFixed(2));
}

module.exports = {
    calcularValorBruto,
    calcularValorFinal,
    identificarTabelaPorEspacos,
    TABELAS_PRECOS,
};
