.bail on
PRAGMA foreign_keys=OFF;
BEGIN;

DROP TABLE IF EXISTS temp.tmp_map;
CREATE TEMP TABLE tmp_map(
  documento TEXT PRIMARY KEY,
  email     TEXT,
  contato   TEXT
);

INSERT OR REPLACE INTO tmp_map VALUES ('17654804000107','auditorios@medgrupo.com.br','(21) 99891-0910 / (21) 98209-3040'); -- MEDGRUPO
INSERT OR REPLACE INTO tmp_map VALUES ('00300771339','souandreluis@gmail.com','(82) 98822-7274'); -- ANDRÉ LUÍS BONFIM SOUSA.
INSERT OR REPLACE INTO tmp_map VALUES ('14149596000109','albuquerquedelucena@gmail.com','(82) 98187-0017'); -- EMPRESA M ALBUQUERQUE & CIA LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('37922328000175','christianomarinho3@gmail.com','(82) 9 9621-5688'); -- CM PRODUÇÕES
INSERT OR REPLACE INTO tmp_map VALUES ('17361388000159','cepec.al@hotmail.com','(82) 9 8862-7871'); -- CENTRO DE PESQUISA CÊNICA - CEPEC
INSERT OR REPLACE INTO tmp_map VALUES ('35157090000103','sec.lacosdosaber@gmail.com','(82) 9 8159-1974'); -- CRECHE LAÇOS DO SABER
INSERT OR REPLACE INTO tmp_map VALUES ('61024498000117','producaoga.al@gmail.com','(82) 9 9800-9182'); -- G A ENTRETENIMENTO
INSERT OR REPLACE INTO tmp_map VALUES ('09338997000169','cleovaz@systemidiomas.com.br','(21) 9 8001-1166'); -- SYSTEM IDIOMAS
INSERT OR REPLACE INTO tmp_map VALUES ('04489388632','carinapreis@hotmail.com','(82) 9 9969-0692'); -- CARINA PRISCILLA DE PAULA REIS
INSERT OR REPLACE INTO tmp_map VALUES ('12416933000143','mariaduarte.mgconfeccoes@gmail.com','(82) 9 8188-7089'); -- EMPRESA SALTARE LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('07800488000180','anny_gabrielle1@outlook.com','(82) 9956-2540 (Anny)'); -- CENTRO EDUCACIONAL NOVO ALVORECER LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('13063572000161','beatrizcavalcantecmf@gmail.com','(82) 99837-2830'); -- COLÉGIO MARIA DE FÁTIMA
INSERT OR REPLACE INTO tmp_map VALUES ('31443184000198','admoficinadavida@hotmail.com','(82) 9 9101-8892'); -- ESCOLA OFICINA DA VIDA
INSERT OR REPLACE INTO tmp_map VALUES ('03879039000119','educ.sinai@hotmail.com','(82) 9 8816-2316'); -- COLÉGIO MONTE SINAI LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('45455018000189','colegiomanoelcandido23@gmail.com','(82) 9 8857-6852'); -- COLÉGIO MANOEL CÂNDIDO
INSERT OR REPLACE INTO tmp_map VALUES ('23077818000108','rafinha_goncalves@hotmail.com','(82) 9 9309-4488'); -- CRECHE ESCOLA A CASA MÁGICA
INSERT OR REPLACE INTO tmp_map VALUES ('02890163000112','agendamento@multieventos.com','(82) 9 8831-7198'); -- EMPRESA MULTIEVENTOS PROMOÇÕES E
ASSESSORIA
INSERT OR REPLACE INTO tmp_map VALUES ('34116804000172','colegioiepoficial@gmail.com','(82) 9 9178-4460'); -- COLÉGIO IEP LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('32088484000169','direcao@littletown.net.br','(82) 9 9990-9717'); -- EMPRESA LITTE TOWN ESCOLA DE ENSINO INFANTIL
LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('37992577000137','attoartes@gmail.com','(82) 9 9193-7382'); -- ATTO ACADEMIA DE ARTES
INSERT OR REPLACE INTO tmp_map VALUES ('33191527000108','williams-patrik@hotmail.com','(82) 9 8831-7198'); -- ESCOLA E CRECHE LUCENA KIDS LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('13181652000111','produtorakratendimento@gmail.com','(82) 9 8868-3745'); -- PRODUTORA KR
INSERT OR REPLACE INTO tmp_map VALUES ('15629906000147','casademusicavillalobos@hotmail.com','(82) 9 9361-3777'); -- EMPRESA FREITAS & SILVA INSTRUMENTO MUSICAIS
LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('49453700000120','allegrostudiodedancaa@gmail.com','(82) 9 9109-2002'); -- ALLEGRO STUDIO DE DANÇA E ARTE
INSERT OR REPLACE INTO tmp_map VALUES ('51543570000169','ecostreinamentosecursos@gmail.com','(79) 9 9859-8847'); -- ECOS TREINAMENTOS E CURSOS LTDA
INSERT OR REPLACE INTO tmp_map VALUES ('17654804000107','auditorios@medgrupo.com.br / luciene.gama@rmedcursosmedicos.com.br','(21) 9 9891-0910 / (21) 98209-3040'); -- RMED CURSOS MÉDICOS LTDA

-- Apply EMAIL when current is NULL/empty/placeholder
UPDATE Clientes_Eventos AS c
SET email = COALESCE(
  (SELECT m.email
     FROM tmp_map m
    WHERE m.documento = COALESCE(c.documento_norm, REPLACE(REPLACE(REPLACE(c.documento,'.',''),'/',''),'-',''))
      AND m.email IS NOT NULL AND TRIM(m.email) <> ''
  ),
  email
)
WHERE c.email IS NULL OR TRIM(c.email)='' OR c.email LIKE 'sem.email.%@importado.placeholder';

-- Apply CONTATO when empty
UPDATE Clientes_Eventos AS c
SET nome_responsavel = COALESCE(
  (SELECT m.contato
     FROM tmp_map m
    WHERE m.documento = COALESCE(c.documento_norm, REPLACE(REPLACE(REPLACE(c.documento,'.',''),'/',''),'-',''))
      AND m.contato IS NOT NULL AND TRIM(m.contato) <> ''
  ),
  nome_responsavel
)
WHERE c.nome_responsavel IS NULL OR TRIM(c.nome_responsavel)='';

.headers on
.mode column
.print '';
.print '== Restantes com email vazio ==';
SELECT COUNT(*) AS faltando FROM Clientes_Eventos WHERE email IS NULL OR TRIM(email)='';

.print '';
.print '== Amostra atualizados ==';
SELECT nome_razao_social AS cliente,
       COALESCE(documento_norm, documento) AS documento,
       nome_responsavel AS contato,
       email
FROM Clientes_Eventos
WHERE email IS NOT NULL AND TRIM(email) <> ''
ORDER BY cliente
LIMIT 30;

COMMIT;
