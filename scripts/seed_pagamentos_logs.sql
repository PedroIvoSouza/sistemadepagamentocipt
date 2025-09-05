PRAGMA foreign_keys=ON;
BEGIN;

-- Cache mínimo para consultas e auditoria
CREATE TABLE IF NOT EXISTS pagamentos_cache (
  dar_id INTEGER NOT NULL,
  numero_guia TEXT NOT NULL,
  codigo_barras TEXT,
  data_arrecadacao TEXT NOT NULL, -- YYYY-MM-DD
  cnpj TEXT,
  valor_total REAL,
  fonte TEXT DEFAULT 'log-conciliacao',
  PRIMARY KEY (dar_id, data_arrecadacao),
  FOREIGN KEY (dar_id) REFERENCES dars(id)
);

-- Lista de pagamentos extraída dos seus logs (SUCESSO)
WITH novos(numero_guia, data_arrecadacao, codigo_barras, cnpj) AS (
  VALUES
  ('151933863','2025-08-25','85870000032896000022025082900000015193386319','06935095000111'),
  ('153093692','2025-08-26','85890000025393000022025082600000015309369219','08911934000197'),
  ('153103691','2025-08-26','85850000023610500022025082600000015310369119','40411089000101'),
  ('152006267','2025-08-26','85800000014864000022025082900000015200626719','14876384000115'),
  ('152024410','2025-08-28','85840000012768000022025082900000015202441019','09584747000109'),
  ('153206115','2025-08-28','85820000023876500022025082900000015320611519','28207096000182'),
  ('152004086','2025-08-28','85880000074113000022025082900000015200408619','13055903000111'),
  ('152005277','2025-08-28','85880000015470000022025082900000015200527719','29500928000117'),
  ('152008090','2025-08-28','85860000038165500022025082900000015200809019','01703922000128'),
  ('151929759','2025-08-29','85830000043967000022025082900000015192975919','05301393000197'),
  ('151998004','2025-08-29','85870000015808000022025082900000015199800419','43495124000106'),
  ('151931814','2025-08-29','85800000091264000022025082900000015193181419','16918665000119'),
  ('151927798','2025-08-29','85850000014076000022025082900000015192779819','32860087000163'),
  ('151932898','2025-08-29','85870000045125000022025082900000015193289819','10882812000161'),
  ('152002416','2025-08-29','85800000015820000022025082900000015200241619','37432689000133'),
  ('152006849','2025-08-29','85880000014800000022025082900000015200684919','12439637000168'),
  ('152016081','2025-08-29','85890000012872000022025082900000015201608119','22080376000196'),
  ('151998381','2025-08-29','85840000032882000022025082900000015199838119','12257462000178')
)

-- Insere no cache (resolve dar_id por numero_documento OU codigo_barras)
INSERT OR IGNORE INTO pagamentos_cache
(dar_id, numero_guia, codigo_barras, data_arrecadacao, cnpj, valor_total, fonte)
SELECT d.id, n.numero_guia, n.codigo_barras, n.data_arrecadacao, n.cnpj, d.valor, 'log-conciliacao'
FROM novos n
JOIN dars d
  ON d.numero_documento = n.numero_guia
  OR (n.codigo_barras IS NOT NULL AND n.codigo_barras <> '' AND d.codigo_barras = n.codigo_barras);

-- Atualiza data_pagamento e status nas DARs correspondentes (por numero_documento)
UPDATE dars
SET data_pagamento = (
      SELECT n.data_arrecadacao FROM novos n
      WHERE n.numero_guia = dars.numero_documento
      LIMIT 1
    ),
    status = 'Pago'
WHERE EXISTS (SELECT 1 FROM novos n WHERE n.numero_guia = dars.numero_documento);

-- (Opcional) também casa por codigo_barras quando necessário
UPDATE dars
SET data_pagamento = COALESCE(
      data_pagamento,
      (SELECT n.data_arrecadacao FROM novos n
       WHERE n.codigo_barras = dars.codigo_barras
       LIMIT 1)
    ),
    status = CASE
      WHEN EXISTS (SELECT 1 FROM novos n WHERE n.codigo_barras = dars.codigo_barras)
      THEN 'Pago' ELSE status END
WHERE EXISTS (SELECT 1 FROM novos n WHERE n.codigo_barras = dars.codigo_barras);

COMMIT;

-- Índices úteis (opcionais)
CREATE INDEX IF NOT EXISTS idx_dars_numero_documento ON dars(numero_documento);
CREATE INDEX IF NOT EXISTS idx_dars_codigo_barras ON dars(codigo_barras);
CREATE INDEX IF NOT EXISTS idx_cache_dar_id ON pagamentos_cache(dar_id);
