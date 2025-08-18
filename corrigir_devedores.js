// corrigir_devedores.js
// Uso:
//   node corrigir_devedores.js            # aplica alterações
//   node corrigir_devedores.js --dryRun   # só mostra o que faria, sem atualizar
//
// Dep.: sqlite3 (já tem no projeto)

const sqlite3 = require('sqlite3').verbose();

const args = process.argv.slice(2).map(s => s.toLowerCase());
const DRY = args.includes('--dryrun') || args.includes('--dry');

const db = new sqlite3.Database('./sistemacipt.db');

const onlyDigits = (s) => (s || '').toString().replace(/\D+/g, '');

// ===================== SUA LISTA =====================
// Formato: cnpj (apenas dígitos) e lista de meses/anos a marcar como devidos.
// Para intervalos, use { range: ['YYYY-MM','YYYY-MM'] } (inclusive).
const devedores = [
  {
    nome: 'CIT TECNOLOGIA',
    cnpj: '22080376000196',
    meses: ['2025-05', '2025-06']
  },
  {
    nome: 'DMD2',
    cnpj: '09584747000109',
    meses: ['2025-04', '2025-06', '2025-07']
  },
  {
    nome: 'GO DESENVOLVIMENTO',
    cnpj: '21950824000100',
    meses: [
      '2023-08',
      '2023-12',
      '2024-01',
      { range: ['2024-02', '2025-06'] }
    ]
  },
  {
    nome: 'ID5',
    cnpj: '03370669000163',
    meses: ['2025-03', '2025-04', '2025-05', '2025-06', '2025-07']
  },
  {
    nome: 'ORSOLIGHT',
    cnpj: '40411089000101',
    meses: ['2025-03', '2025-04', '2025-05', '2025-06', '2025-07']
  }
];
// =====================================================

function expandMeses(entry) {
  const out = [];
  for (const m of entry.meses) {
    if (typeof m === 'string') {
      const [y, mm] = m.split('-').map(x => parseInt(x, 10));
      out.push({ ano: y, mes: mm });
    } else if (m && typeof m === 'object' && Array.isArray(m.range) && m.range.length === 2) {
      let [y1, m1] = m.range[0].split('-').map(x => parseInt(x, 10));
      const [y2, m2] = m.range[1].split('-').map(x => parseInt(x, 10));
      while (y1 < y2 || (y1 === y2 && m1 <= m2)) {
        out.push({ ano: y1, mes: m1 });
        m1++;
        if (m1 > 12) { m1 = 1; y1++; }
      }
    }
  }
  return out;
}

function getPermissionarioIdByCNPJ(cnpj) {
  return new Promise(resolve => {
    db.get(
      `SELECT id, nome_empresa, cnpj FROM permissionarios
       WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`,
      [cnpj],
      (err, row) => resolve(row || null)
    );
  });
}

function getDARByPermMesAno(permId, mes, ano) {
  return new Promise(resolve => {
    db.all(
      `SELECT id, status, data_pagamento, valor, data_vencimento
         FROM dars
        WHERE permissionario_id = ?
          AND mes_referencia = ?
          AND ano_referencia = ?`,
      [permId, mes, ano],
      (err, rows) => resolve(rows || [])
    );
  });
}

function marcarVencida(darId) {
  return new Promise(resolve => {
    if (DRY) return resolve(true);
    db.run(
      `UPDATE dars
          SET status = 'Vencida',
              data_pagamento = NULL
        WHERE id = ?`,
      [darId],
      function (err) {
        if (err) console.error('ERRO UPDATE dars.id=', darId, err.message);
        resolve(!err);
      }
    );
  });
}

(async function main() {
  let totAtualizadas = 0;
  let totNaoEncontradas = 0;
  console.log(DRY ? '*** DRY RUN (nenhuma alteração será gravada) ***' : '*** APLICANDO CORREÇÕES DEVEDORES ***');

  for (const entry of devedores) {
    const cnpj = onlyDigits(entry.cnpj);
    const meses = expandMeses(entry);
    const perm = await getPermissionarioIdByCNPJ(cnpj);

    if (!perm) {
      console.warn(`WARN: permissionário não encontrado para ${entry.nome} (${cnpj}). Pulei.`);
      continue;
    }

    console.log(`\n== ${entry.nome} (${perm.cnpj}) → id=${perm.id}`);
    for (const { mes, ano } of meses) {
      const dars = await getDARByPermMesAno(perm.id, mes, ano);
      if (!dars.length) {
        console.warn(`  - ${ano}-${String(mes).padStart(2,'0')}: DAR não encontrada`);
        totNaoEncontradas++;
        continue;
      }
      // Se houver mais de uma (raro), atualiza todas
      for (const d of dars) {
        const ok = await marcarVencida(d.id);
        console.log(`  - ${ano}-${String(mes).padStart(2,'0')}: dars.id=${d.id} status ${DRY ? '(simulado → Vencida)' : '→ Vencida'}`);
        if (ok && !DRY) totAtualizadas++;
      }
    }
  }

  console.log(`\nResumo: ${DRY ? '(simulado) ' : ''}Atualizadas=${totAtualizadas} | Não encontradas=${totNaoEncontradas}`);
  db.close();
})();
