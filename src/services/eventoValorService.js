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

const DEFAULT_LABELS = {
    AUDITORIO: 'Auditório',
    ANFITEATRO: 'Anfiteatro',
};

const DEFAULT_TABELAS = {
    AUDITORIO: buildTabela([2495.0, 1996.0, 1596.8, 1277.44]),
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

function buildDefaultMetadados() {
    const tabela = new Map();
    Object.keys(DEFAULT_TABELAS).forEach((chave) => {
        const valores = parseTabelaOverride(chave, DEFAULT_TABELAS[chave]);
        tabela.set(chave, {
            label: DEFAULT_LABELS[chave] || chave,
            valores,
            capacidade: null,
            area_m2: null,
            prioridade: valores[0] || 0,
        });
    });
    return tabela;
}

function cloneMetadados(source) {
    const clone = new Map();
    source.forEach((value, key) => {
        clone.set(key, {
            label: value.label,
            valores: [...value.valores],
            capacidade: value.capacidade ?? null,
            area_m2: value.area_m2 ?? null,
            prioridade: value.prioridade ?? value.valores?.[0] ?? 0,
        });
    });
    return clone;
}

let tabelaMetadados = buildDefaultMetadados();
let aliasToTabelaKey = new Map([
    ['AUDITORIO', 'AUDITORIO'],
    ['ANFITEATRO', 'ANFITEATRO'],
]);
let tabelasPrecosCache = {};

function rebuildCacheFromMetadados() {
    const cache = {};
    tabelaMetadados.forEach((meta, key) => {
        cache[key] = [...meta.valores];
    });
    tabelasPrecosCache = cache;
}

rebuildCacheFromMetadados();

function normalizarEspacoNome(espaco) {
    if (!espaco) return '';
    return String(espaco)
        .normalize('NFD')
        .replace(/[^\w\s]/g, '')
        .trim()
        .toUpperCase();
}

function setEspacosTabelaOverrides(configs = []) {
    const novaTabela = cloneMetadados(buildDefaultMetadados());
    const novoAliasMap = new Map([
        ['AUDITORIO', 'AUDITORIO'],
        ['ANFITEATRO', 'ANFITEATRO'],
    ]);

    configs
        .filter(Boolean)
        .forEach((config) => {
            const chave = normalizarEspacoNome(config.tabelaKey || config.nome || config.slug);
            if (!chave) return;

            const valores = buildTabela(
                Array.isArray(config.valores) && config.valores.length
                    ? config.valores
                    : [
                          config.valor_diaria_1,
                          config.valor_diaria_2,
                          config.valor_diaria_3,
                          config.valor_diaria_adicional,
                      ]
            );

            const prioridade = Number.isFinite(config.prioridade)
                ? Number(config.prioridade)
                : valores[0] || 0;

            novaTabela.set(chave, {
                label: config.label || config.nome || config.slug || chave,
                valores,
                capacidade: Number.isFinite(config.capacidade) ? Number(config.capacidade) : null,
                area_m2: Number.isFinite(config.area_m2) ? Number(config.area_m2) : null,
                prioridade,
            });

            const aliasCandidates = [
                config.tabelaKey,
                config.nome,
                config.slug,
                ...(Array.isArray(config.aliases) ? config.aliases : []),
            ];

            aliasCandidates.forEach((candidate) => {
                const norm = normalizarEspacoNome(candidate);
                if (norm) novoAliasMap.set(norm, chave);
            });

            novoAliasMap.set(chave, chave);
        });

    tabelaMetadados = novaTabela;
    aliasToTabelaKey = novoAliasMap;
    rebuildCacheFromMetadados();
}

function flattenEspacosLista(input, acc = []) {
    if (Array.isArray(input)) {
        input.forEach((item) => flattenEspacosLista(item, acc));
    } else if (input !== undefined && input !== null) {
        acc.push(input);
    }
    return acc;
}

const CONNECTOR_REGEX = /(?:\s+e\s+|,|;|\/|&|\+|\s+-\s+)/i;

function expandEspacosCandidatos(valor) {
    const candidatos = [];
    if (valor === undefined || valor === null) return candidatos;

    const texto = typeof valor === 'string' ? valor : String(valor);
    const trimmed = texto.trim();
    if (!trimmed) return candidatos;

    candidatos.push(trimmed);

    const partes = trimmed.split(CONNECTOR_REGEX).map((parte) => parte.trim()).filter(Boolean);
    if (partes.length > 1) {
        partes.forEach((parte) => {
            if (!candidatos.includes(parte)) candidatos.push(parte);
        });
    }

    return candidatos;
}

function identificarTabelaPorEspacos(espacos = []) {
    const lista = flattenEspacosLista(espacos);
    const candidatos = [];

    lista.forEach((entrada) => {
        const partes = expandEspacosCandidatos(entrada);
        if (partes.length) candidatos.push(...partes);
    });

    const normalizados = [];
    const vistos = new Set();

    candidatos.forEach((parte) => {
        const norm = normalizarEspacoNome(parte);
        if (!norm || vistos.has(norm)) return;
        vistos.add(norm);
        normalizados.push(norm);

        if (/\d/.test(norm)) {
            const semNumeros = norm.replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim();
            if (semNumeros && !vistos.has(semNumeros)) {
                vistos.add(semNumeros);
                normalizados.push(semNumeros);
            }
        }
    });

    if (!normalizados.length) return 'AUDITORIO';

    let melhorChave = 'AUDITORIO';
    let melhorPrioridade = Number.NEGATIVE_INFINITY;
    let encontrouCorrespondencia = false;

    for (const nome of normalizados) {
        const chave = aliasToTabelaKey.get(nome);
        if (!chave) continue;
        const meta = tabelaMetadados.get(chave);
        if (!meta) continue;
        const prioridade = Number(meta.prioridade ?? meta.valores?.[0] ?? 0);
        if (prioridade > melhorPrioridade) {
            melhorChave = chave;
            melhorPrioridade = prioridade;
            encontrouCorrespondencia = true;
        }
    }

    if (!encontrouCorrespondencia) return 'AUDITORIO';
    return melhorChave || 'AUDITORIO';
}

function getTabelaPorChave(chave) {
    return (
        tabelasPrecosCache[chave] ||
        tabelasPrecosCache.AUDITORIO ||
        DEFAULT_TABELAS.AUDITORIO
    );
}

function getTabelaPrecosSnapshot() {
    const tabelas = {};
    tabelaMetadados.forEach((meta, key) => {
        tabelas[key] = {
            label: meta.label || key,
            valores: [...meta.valores],
            capacidade: meta.capacidade,
            area_m2: meta.area_m2,
        };
    });

    const aliases = {};
    aliasToTabelaKey.forEach((destino, alias) => {
        aliases[alias] = destino;
    });

    return { tabelas, aliases };
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
    const precosPorDia = getTabelaPorChave(chaveTabela);

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
    setEspacosTabelaOverrides,
    getTabelaPrecosSnapshot,
    normalizarEspacoNome,
};
