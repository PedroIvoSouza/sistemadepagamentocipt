.bail on
PRAGMA foreign_keys=OFF;
BEGIN;

-- Normalização de documentos no banco
UPDATE Clientes_Eventos
SET documento_norm = REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','')
WHERE documento IS NOT NULL AND (documento_norm IS NULL OR TRIM(documento_norm)='');

UPDATE Clientes_Eventos
SET documento_raiz = SUBSTR(documento_norm,1,8)
WHERE documento_norm IS NOT NULL AND LENGTH(documento_norm)=14
  AND (documento_raiz IS NULL OR TRIM(documento_raiz)='');

-- Tabela temporária com dados da planilha
DROP TABLE IF EXISTS temp.tmp_map;
CREATE TEMP TABLE tmp_map(
  documento TEXT PRIMARY KEY,
  email     TEXT,
  contato   TEXT
);
INSERT OR REPLACE INTO tmp_map VALUES ('00300771339','souandreluis@gmail.com','(82) 98822-7274');
INSERT OR REPLACE INTO tmp_map VALUES ('02890163000112','agendamento@multieventos.com','(82) 9 8831-7198');
INSERT OR REPLACE INTO tmp_map VALUES ('03879039000119','educ.sinai@hotmail.com','(82) 9 8816-2316');
INSERT OR REPLACE INTO tmp_map VALUES ('04489388632','carinapreis@hotmail.com','(82) 9 9969-0692');
INSERT OR REPLACE INTO tmp_map VALUES ('07800488000180','anny_gabrielle1@outlook.com','(82) 9956-2540 (Anny)');
INSERT OR REPLACE INTO tmp_map VALUES ('09338997000169','cleovaz@systemidiomas.com.br','(21) 9 8001-1166');
INSERT OR REPLACE INTO tmp_map VALUES ('12416933000143','mariaduarte.mgconfeccoes@gmail.com','(82) 9 8188-7089');
INSERT OR REPLACE INTO tmp_map VALUES ('13063572000161','beatrizcavalcantecmf@gmail.com','(82) 99837-2830');
INSERT OR REPLACE INTO tmp_map VALUES ('13181652000111','produtorakratendimento@gmail.com','(82) 9 8868-3745');
INSERT OR REPLACE INTO tmp_map VALUES ('14149596000109','albuquerquedelucena@gmail.com','(82) 98187-0017');
INSERT OR REPLACE INTO tmp_map VALUES ('15629906000147','casademusicavillalobos@hotmail.com','(82) 9 9361-3777');
INSERT OR REPLACE INTO tmp_map VALUES ('17361388000159','cepec.al@hotmail.com','(82) 9 8862-7871');
INSERT OR REPLACE INTO tmp_map VALUES ('17654804000107','auditorios@medgrupo.com.br / luciene.gama@rmedcursosmedicos.com.br','(21) 9 9891-0910 / (21) 98209-3040');
INSERT OR REPLACE INTO tmp_map VALUES ('23077818000108','rafinha_goncalves@hotmail.com','(82) 9 9309-4488');
INSERT OR REPLACE INTO tmp_map VALUES ('31443184000198','admoficinadavida@hotmail.com','(82) 9 9101-8892');
INSERT OR REPLACE INTO tmp_map VALUES ('32088484000169','direcao@littletown.net.br','(82) 9 9990-9717');
INSERT OR REPLACE INTO tmp_map VALUES ('33191527000108','williams-patrik@hotmail.com','(82) 9 8831-7198');
INSERT OR REPLACE INTO tmp_map VALUES ('34116804000172','colegioiepoficial@gmail.com','(82) 9 9178-4460');
INSERT OR REPLACE INTO tmp_map VALUES ('35157090000103','sec.lacosdosaber@gmail.com','(82) 9 8159-1974');
INSERT OR REPLACE INTO tmp_map VALUES ('37922328000175','christianomarinho3@gmail.com','(82) 9 9621-5688');
INSERT OR REPLACE INTO tmp_map VALUES ('37992577000137','attoartes@gmail.com','(82) 9 9193-7382');
INSERT OR REPLACE INTO tmp_map VALUES ('45455018000189','colegiomanoelcandido23@gmail.com','(82) 9 8857-6852');
INSERT OR REPLACE INTO tmp_map VALUES ('49453700000120','allegrostudiodedancaa@gmail.com','(82) 9 9109-2002');
INSERT OR REPLACE INTO tmp_map VALUES ('51543570000169','ecostreinamentosecursos@gmail.com','(79) 9 9859-8847');
INSERT OR REPLACE INTO tmp_map VALUES ('61024498000117','producaoga.al@gmail.com','(82) 9 9800-9182');

-- Aplicar email (sempre que vier na planilha)
UPDATE Clientes_Eventos AS c
SET email = LOWER(TRIM(t.email))
FROM tmp_map t
WHERE (c.documento_norm = t.documento
       OR REPLACE(REPLACE(REPLACE(c.documento,'.',''),'/',''),'-','') = t.documento)
  AND t.email IS NOT NULL AND TRIM(t.email)<>'';

-- Aplicar contato (se vier na planilha)
UPDATE Clientes_Eventos AS c
SET nome_responsavel = t.contato
FROM tmp_map t
WHERE (c.documento_norm = t.documento
       OR REPLACE(REPLACE(REPLACE(c.documento,'.',''),'/',''),'-','') = t.documento)
  AND t.contato IS NOT NULL AND TRIM(t.contato)<>'';

COMMIT;

-- Relatórios rápidos
.headers on
.mode column
.print ''
.print '== Pós-compatibilização =='
SELECT 
  COUNT(*) AS total_clientes,
  SUM(CASE WHEN email IS NULL OR TRIM(email)='' THEN 1 ELSE 0 END) AS emails_vazios,
  SUM(CASE WHEN email LIKE 'sem.email.%@importado.placeholder' THEN 1 ELSE 0 END) AS placeholders
FROM Clientes_Eventos;

.print ''
.print '== Amostra (30) =='
.width 44 18 30 44
SELECT nome_razao_social AS cliente,
       COALESCE(documento_norm, documento) AS documento,
       nome_responsavel AS contato,
       email
FROM Clientes_Eventos
ORDER BY cliente
LIMIT 30;
