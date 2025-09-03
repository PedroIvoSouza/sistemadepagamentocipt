-- Atualização de Clientes_Eventos com base na planilha (contato/email).
PRAGMA foreign_keys=ON;
BEGIN TRANSACTION;

-- Normalizar documento_norm/raiz se necessário
UPDATE Clientes_Eventos
SET documento_norm = REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','')
WHERE documento IS NOT NULL AND (documento_norm IS NULL OR documento_norm='');
UPDATE Clientes_Eventos
SET documento_raiz = SUBSTR(documento_norm,1,8)
WHERE documento_norm IS NOT NULL AND length(documento_norm)=14 AND (documento_raiz IS NULL OR documento_raiz='');

-- ANDRÉ LUÍS BONFIM SOUSA. / 00300771339
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('souandreluis@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 98822-7274',''), nome_responsavel)
WHERE documento_norm = '00300771339' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '00300771339';
-- EMPRESA MULTIEVENTOS PROMOÇÕES E
ASSESSORIA / 02890163000112
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('agendamento@multieventos.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 8831-7198',''), nome_responsavel)
WHERE documento_norm = '02890163000112' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '02890163000112';
-- COLÉGIO MONTE SINAI LTDA / 03879039000119
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('educ.sinai@hotmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 8816-2316',''), nome_responsavel)
WHERE documento_norm = '03879039000119' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '03879039000119';
-- CARINA PRISCILLA DE PAULA REIS / 04489388632
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('carinapreis@hotmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 9969-0692',''), nome_responsavel)
WHERE documento_norm = '04489388632' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '04489388632';
-- CENTRO EDUCACIONAL NOVO ALVORECER LTDA / 07800488000180
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('anny_gabrielle1@outlook.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9956-2540 (Anny)',''), nome_responsavel)
WHERE documento_norm = '07800488000180' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '07800488000180';
-- SYSTEM IDIOMAS / 09338997000169
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('cleovaz@systemidiomas.com.br',''), email),
    nome_responsavel = COALESCE(NULLIF('(21) 9 8001-1166',''), nome_responsavel)
WHERE documento_norm = '09338997000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '09338997000169';
-- EMPRESA SALTARE LTDA / 12416933000143
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('mariaduarte.mgconfeccoes@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 8188-7089',''), nome_responsavel)
WHERE documento_norm = '12416933000143' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '12416933000143';
-- COLÉGIO MARIA DE FÁTIMA / 13063572000161
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('beatrizcavalcantecmf@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 99837-2830',''), nome_responsavel)
WHERE documento_norm = '13063572000161' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13063572000161';
-- PRODUTORA KR / 13181652000111
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('produtorakratendimento@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 8868-3745',''), nome_responsavel)
WHERE documento_norm = '13181652000111' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13181652000111';
-- EMPRESA M ALBUQUERQUE & CIA LTDA / 14149596000109
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('albuquerquedelucena@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 98187-0017',''), nome_responsavel)
WHERE documento_norm = '14149596000109' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '14149596000109';
-- EMPRESA FREITAS & SILVA INSTRUMENTO MUSICAIS
LTDA / 15629906000147
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('casademusicavillalobos@hotmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 9361-3777',''), nome_responsavel)
WHERE documento_norm = '15629906000147' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '15629906000147';
-- CENTRO DE PESQUISA CÊNICA - CEPEC / 17361388000159
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('cepec.al@hotmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 8862-7871',''), nome_responsavel)
WHERE documento_norm = '17361388000159' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17361388000159';
-- RMED CURSOS MÉDICOS LTDA / 17654804000107
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('',''), email),
    nome_responsavel = COALESCE(NULLIF('(21) 9 9891-0910 / (21) 98209-3040',''), nome_responsavel)
WHERE documento_norm = '17654804000107' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17654804000107';
-- CRECHE ESCOLA A CASA MÁGICA / 23077818000108
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('rafinha_goncalves@hotmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 9309-4488',''), nome_responsavel)
WHERE documento_norm = '23077818000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '23077818000108';
-- ESCOLA OFICINA DA VIDA / 31443184000198
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('admoficinadavida@hotmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 9101-8892',''), nome_responsavel)
WHERE documento_norm = '31443184000198' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '31443184000198';
-- EMPRESA LITTE TOWN ESCOLA DE ENSINO INFANTIL
LTDA / 32088484000169
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('direcao@littletown.net.br',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 9990-9717',''), nome_responsavel)
WHERE documento_norm = '32088484000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '32088484000169';
-- ESCOLA E CRECHE LUCENA KIDS LTDA / 33191527000108
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('williams-patrik@hotmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 8831-7198',''), nome_responsavel)
WHERE documento_norm = '33191527000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '33191527000108';
-- COLÉGIO IEP LTDA / 34116804000172
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('colegioiepoficial@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 9178-4460',''), nome_responsavel)
WHERE documento_norm = '34116804000172' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '34116804000172';
-- CRECHE LAÇOS DO SABER / 35157090000103
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('sec.lacosdosaber@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 8159-1974',''), nome_responsavel)
WHERE documento_norm = '35157090000103' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '35157090000103';
-- CM PRODUÇÕES / 37922328000175
UPDATE Clientes_Eventos
SET email = COALESCE(NULLIF('christianomarinho3@gmail.com',''), email),
    nome_responsavel = COALESCE(NULLIF('(82) 9 9621-5688',''), nome_responsavel)
WHERE documento_norm = '37922328000175' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '37922328000175';
COMMIT;